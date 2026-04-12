local keywords = {}
("and break do else elseif end false for function goto if in local nil not or \
repeat return then true until while"):gsub("%S+", function(s)
	keywords[s] = true
end)
local function valid_ident(s)
	if #s == 0 or keywords[s] or not s:match("^[A-Za-z_][A-Za-z0-9_]*$") then
		return false
	end
	return true
end

-- for readability aim to dump simple and short tables in a compact way
local function dump_simple(obj)
	if type(obj) ~= "table" then
		return
	end
	local keys = {}
	for k, v in pairs(obj) do
		local tv = type(v)
		if not (tv == "number" or tv == "boolean" or (tv == "string" and #v < 20)) then
			return
		end
		if not (type(k) == "string" and valid_ident(k) and #k <= 10 and #keys < 10) then
			return
		end
		keys[#keys+1] = k
	end
	if #keys == 0 then
		return "{}"
	end
	table.sort(keys)
	local rope = {"{ "}
	for _, k in ipairs(keys) do
		rope[#rope+1] = k
		rope[#rope+1] = "="
		rope[#rope+1] = dump(obj[k])
		rope[#rope+1] = ", "
	end
	rope[#rope] = " }"
	return table.concat(rope, "")
end

local function mydump(obj)
	local ret = dump_simple(obj)
	return ret or dump(obj)
end

return mydump
