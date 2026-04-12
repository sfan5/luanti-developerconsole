-- SPDX-License-Identifier: LGPL-2.1-or-later

local dc = {}

-- use these over calling the normal functions to avoid infinite loops
local old_core_log = core.log
local old_print = print

local BASE_URL = "http://localhost:3001"
local LONG_POLL_TIMEOUT = 100 -- more than in server.js
local SHORT_TIMEOUT = 2.5
local EAGER_FLUSH_TIMEOUT = 100 * 1000 -- us

local http -- HTTP API table
if core.request_http_api then
	http = core.request_http_api()
end
if not http then
	local name = core.get_current_modname()
	core.log("error", "Access to the HTTP API is required for the console to work. Please add "..
		name.." to your 'secure.http_mods'.")
	return
end

--[[
list of ideas:
* send tables with structure so they can be displayed tree view-like
* show line/source for defined functions (debug.getinfo) <-> source inspector
* mod storage viewer?
* tab complete node and group names (+ entities?)
* basic profiler (top function calls in globalstep)??
* allow multiline editing *or* separate code editor with saved snippets?
* integrate with lua_api to show function params
* switch to webpack+typescript or whatever is needed

--]]

local mydump = dofile(core.get_modpath(core.get_current_modname()) .. "/dump.lua")

local function do_eval(msg)
	-- note: no brackets to allow multiple return values
	local func, err = loadstring("return " .. msg.code)
	if not func then -- maybe a bit stupid but it works
		func, err = loadstring(msg.code)
	end
	if not func then
		return {syntax_error = err}
	end

	local ret = {pcall(func)}
	local success = table.remove(ret, 1)
	if not success then
		return {runtime_error = tostring(ret[1])}
	end

	for i, v in ipairs(ret) do
		ret[i] = mydump(v)
	end
	return {ret = ret}
end

local function do_inspect(msg)
	-- FIXME: this triggers the _G metatable (undeclared warnings)
	local object
	if msg.expr == "" then
		object = _G
	else
		local func, err = loadstring("return (" .. msg.expr .. ")")
		if not func then
			return {error = err}
		end
		local success
		success, object = pcall(func)
		if not success then
			return {error = tostring(object)}
		end
	end

	local ret = {}

	-- try indexing the object
	if msg.index ~= nil and type(object) == "table" then
		local object2 = rawget(object, msg.index)
		if object2 ~= nil then
			object = object2
			ret.was_indexed = true
		end
	end

	local t = type(object)
	ret.type = t
	if t == "table" then
		-- TODO: do array detection here, truncate?
		local keys = {}
		for k, _ in pairs(object) do
			if type(k) == "string" or type(k) == "number" then
				keys[#keys+1] = k
			else
				ret.other_keys = true
			end
		end
		ret.keys = keys
	elseif t == "string" or t == "number" or t == "boolean" then
		-- TODO: truncate strings?
		ret.value = object
	else
		ret.as_string = tostring(object)
	end
	if t == "table" or t == "userdata" or t == "string" then
		local mt = getmetatable(object)
		local func_t
		if type(mt) == "table" and mt.__index ~= nil then
			if type(mt.__index) == "table" then
				func_t = mt.__index
			end
		elseif type(mt) == "table" and t == "userdata" then
			-- engine userdata has a hidden metatable and keeps the bare methods
			-- without __index in the metatable, for some reason
			-- (in violation of normal Lua behavior)
			func_t = mt
		end
		if func_t then
			local funcs = {}
			for k, v in pairs(func_t) do
				-- be extra careful
				if type(k) == "string" and string.sub(k, 1, 2) ~= "__" and type(v) == "function" then
					funcs[#funcs+1] = k
				end
			end
			ret.meta = funcs
		end
	end
	if t == "function" then
		ret.callable = true
	elseif t == "table" or t == "userdata" then
		local mt = getmetatable(object)
		if type(mt) == "table" and type(mt.__call) == "function" then
			ret.callable = true
		end
	end
	return ret
end

function dc.process(msg)
	local action = msg.a or ""
	local reply
	if action == "eval" then
		reply = do_eval(msg)
	elseif action == "inspect" then
		reply = do_inspect(msg)
	else
		old_core_log("warning", "[DC] unhandled message:", dump(msg))
		return
	end
	reply = table.copy(reply)
	reply.id = msg.id
	dc.push(reply)
end

-- Log interception
-- (best-effort, need engine support for this...)

do
	local function concat_args(...)
		local n, t = select("#", ...), {...}
		for i = 1, n do
			t[i] = tostring(t[i])
		end
		return table.concat(t, "\t")
	end
	local level_map = {
		none = 1, error = 2, warning = 3, action = 4,
		info = 5, verbose = 6, trace = 7
	}

	function print(...)
		local s = concat_args(...)
		dc.push({event = "log", s = s})
		old_print(s)
	end

	function core.log(level, text, stack_level)
		if text == nil then
			text = level
			level = "none"
		end
		if level == "deprecated" then
			-- can't handle this ourselves, so just pass it
			-- but make sure the stack level is correct
			old_core_log(level, text, (stack_level or 2) + 1)
			return
		end
		local level_n = level_map[level]
		if level_n ~= nil and level_n <= 4 then -- TODO: this should be adjustable
			dc.push({event = "log", s = tostring(text), l = level_n})
		end
		old_core_log(level, text)
	end
end

-- Long polling loop

local once_ok = 0 -- 0 = not ok, 1 = pending notify, 2 = notified
local function trigger_online_feedback(force)
	local msg = "The developer console is available at " .. BASE_URL
	if once_ok == 1 then
		if #core.get_connected_players() > 0 then
			core.chat_send_all(msg)
			once_ok = 2
		elseif force then
			old_print(msg) -- For headless usage
			once_ok = 2
		end
	end
end

local function process_polled_data(str)
	local data = core.parse_json(str)
	if not data or type(data) ~= "table" then
		old_core_log("warning", "[DC] bogus data: " .. dump(str))
		return
	end
	for _, msg in ipairs(data) do
		dc.process(msg)
	end
end

local online_retry = 0 -- -1 = succeeded already
function dc.poll()
	if online_retry >= 0 then
		-- Ping server first so we can get immediate feedback
		http.fetch({
			url = BASE_URL .. "/ping",
			timeout = SHORT_TIMEOUT,
		}, function(result)
			if result.succeeded and result.code < 400 then
				online_retry = -1
				once_ok = math.max(once_ok, 1)
				trigger_online_feedback()
				core.after(5, trigger_online_feedback, true)
				-- immediately start polling
				dc.poll()
			else
				local delay = math.pow(2, online_retry)
				online_retry = online_retry + 1
				core.after(delay, dc.poll)
				return
			end
		end)
		return
	end

	-- Actual polling
	http.fetch({
		url = BASE_URL .. "/poll",
		timeout = LONG_POLL_TIMEOUT,
		quiet = true,
	}, function(result)
		if result.succeeded and result.code < 400 then
			-- run new poll ASAP
			dc.poll()
			process_polled_data(result.data)
		else
			old_core_log("info", "[DC] poll failed: " .. dump(result))
			core.after(1, dc.poll) -- delay retry
		end
	end)
end
core.after(0, dc.poll)

core.register_on_joinplayer(function(player)
	trigger_online_feedback()
end)

-- Message queue to server
local pending_msgs = {}
local last_flush = 0
function dc.push(data)
	assert(type(data) == "table")
	pending_msgs[#pending_msgs + 1] = data

	if core.get_us_time() >= last_flush + EAGER_FLUSH_TIMEOUT then
		-- if we're somehow stuck in a server step for longer then flush early
		dc.flush()
	end
end

function dc.flush()
	if #pending_msgs == 0 then
		return
	end
	local t = pending_msgs
	pending_msgs = {}
	last_flush = core.get_us_time()
	local json, err = core.write_json(t)
	if err then
		old_core_log("warning", "[DC] json writing failed: " .. err)
		return
	end
	http.fetch({
		url = BASE_URL .. "/push",
		method = "POST",
		data = json,
		extra_headers = { "Content-Type: application/json" },
	}, function(result)
		if not (result.succeeded and result.code < 400) then
			old_core_log("info", "[DC] push failed: " .. dump(result))
		end
	end)
end

core.register_on_mods_loaded(function()
	-- should happen last, if possible
	core.register_globalstep(function()
		 dc.flush()
	end)
end)

core.register_on_shutdown(function()
	dc.flush()
end)
