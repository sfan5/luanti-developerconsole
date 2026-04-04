local dc = {}

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
* capture log/print and show in console (or separate tab?)
* show line/source for defined functions (debug.getinfo) <-> source inspector
* general tab completion when writing e.g. a function call
  -> split "preview" and "tab completion" for this
* indicate if poller is online, show luanti version from user agent
* mod storage viewer??
* send tables with structure so they can be displayed tree view-like
* or at least throw syntax highlighting on the display
* basic profiler (top function calls in globalstep)
* allow multiline editing *or* separate code editor with saved snippets?
* integrate with lua_api to show function params

--]]

local function do_eval(msg)
	-- maybe a bit stupid but it works
	local func, err = loadstring("return (" .. msg.code .. ")")
	if not func then
		func, err = loadstring(msg.code)
	end
	if not func then
		return {syntax_error = err}
	end

	local success, ret = pcall(func)
	if not success then
		return {runtime_error = ret}
	end

	-- this should be something custom for better UX
	return {ret = dump(ret)}
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
			return {error = object}
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
		if mt and t == "table" and type(mt.__index) == "table" then
			func_t = mt.__index
		elseif mt and t ~= "table" then
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
		core.log("warning", "[DC] unhandled message:", dump(msg))
		return
	end
	reply = table.copy(reply)
	reply.id = msg.id
	dc.push(reply)
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
			print(msg) -- For headless usage
			once_ok = 2
		end
	end
end

local online_ok = false
function dc.poll()
	if not online_ok then
		-- Ping server first so we can get immediate feedback
		http.fetch({
			url = BASE_URL .. "/ping",
			timeout = SHORT_TIMEOUT,
		}, function(result)
			if result.succeeded and result.code < 400 then
				online_ok = true
				once_ok = math.max(once_ok, 1)
				trigger_online_feedback()
				core.after(5, trigger_online_feedback, true)
				-- immediately start polling
				dc.poll()
			else
				core.after(1, dc.poll) -- delayed retry
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
			local data = core.parse_json(result.data)
			if data and type(data) == "table" then
				for _, msg in ipairs(data) do
					dc.process(msg)
				end
			end
			dc.poll()
		else
			core.log("info", "[DC] poll failed: " .. dump(result))
			core.after(1, dc.poll) -- delay retry
		end
	end)
end
core.after(0, dc.poll)

core.register_on_joinplayer(function(player)
	trigger_online_feedback()
end)

-- RPC replies
local pending_msgs = {}
local last_flush = 0
function dc.push(data)
	assert(type(data) == "table")
	pending_msgs[#pending_msgs + 1] = data

	if core.get_us_time() >= last_flush + EAGER_FLUSH_TIMEOUT then
		-- if we're somehow stuck in a server step for longer then flush
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
	http.fetch({
		url = BASE_URL .. "/push",
		method = "POST",
		data = core.write_json(t),
		extra_headers = { "Content-Type: application/json" },
	}, function(result)
		if not (result.succeeded and result.code < 400) then
			core.log("info", "[DC] push failed: " .. dump(result))
		end
	end)
end

core.register_on_mods_loaded(function()
	core.after(0, function()
		 -- should happen last, if possible
		 dc.flush()
	end)
end)
