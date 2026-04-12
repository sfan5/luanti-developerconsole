(() => {

const DEBUG = false;
const output = document.getElementById('output');
const input = document.getElementById('input');
const preview = document.getElementById('preview');
const statusText = document.getElementById('status-text');
const statusIcon = document.getElementById('status-icon');

const socket = io(); // Socket.IO

let history = [];
let historyIndex = -1;
const HISTORY_STORAGE_KEY = 'developerconsole.history';
const HISTORY_MAX_ITEMS = 200;

function loadHistory() {
	try {
		const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
		if (!raw) return;
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return;
		history = parsed.filter(item => typeof(item) === 'string');
		historyIndex = history.length;
	} catch (err) {
		console.warn('load history error:', err);
	}
}

function saveHistory() {
	try {
		localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history.slice(-HISTORY_MAX_ITEMS)));
	} catch (err) {
		console.warn('save history error:', err);
	}
}

function updateOnlineStatus(info) {
	if (!socket.active || !socket.connected) {
		// !active means it won't try to reconnect automatically
		statusText.innerText = socket.active ? "Waiting for WebSocket connection\u2026" :
			"Can't connect to WebSocket, try reloading the page";
		statusIcon.innerText = '\u2754';
		input.setAttribute("disabled", "");
		return;
	}
	if (!info) {
		statusText.innerText = "Luanti is not connected";
		statusIcon.innerText = '\u274c';
		input.setAttribute("disabled", "");
		return;
	}
	input.removeAttribute("disabled");
	statusText.innerText = String(info);
	statusIcon.innerText = '\u2705';

	// Auto-focus the input element (which is not possible when it's disabled)
	if (document.activeElement === document.body)
		input.focus();
}

let debounceTimeout; // for preview fetch
let lastPreview = null; // { pExpr, pData }
let pendingPreview = null;
let cachedPreviewData = null; // { expr, index, data, until }

function escapeHtml(text) {
	if (text == null) return '';
	return String(text)
		.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function appendToOutput(text, className = '', after = null, raw = false) {
	const div = document.createElement('div');
	div.innerHTML = raw ? String(text) : escapeHtml(text);
	if (className)
		div.className = className;
	if (after)
		output.insertBefore(div, after.nextSibling);
	else
		output.appendChild(div);
	// scroll to bottom
	output.scrollTop = output.scrollHeight;
	return div;
}

socket.on('connect', () => {
	updateOnlineStatus();
});

socket.on('disconnect', () => {
	updateOnlineStatus();
});

socket.on('online_status', (data) => {
	updateOnlineStatus(data);
});

socket.on('event', (data) => {
	if (!Array.isArray(data)) {
		console.error("Type mismatch: expected array", data);
		return;
	}
	const LOG_LEVELS = [null, "NONE", "ERROR", "WARNING", "ACTION", "INFO", "VERBOSE", "TRACE"];
	for (const it of data) {
		if (it.event == "log") {
			if (typeof(it.l) === 'number' && it.l !== 1) {
				appendToOutput(`${LOG_LEVELS[it.l]}:\u00a0${it.s}`, 'log');
			} else {
				// normal print or log level 'none'
				appendToOutput("\u00a0\u00a0" + it.s);
			}
		} else {
			DEBUG && console.log("unhandled event:", it);
		}
	}
});

/* TODO: all this stuff needs to be rewritten as proper lexing/parsing */

// Allows simple table or array access, no function calls or anything
// FIXME: need to also handle reserved identifiers everywhere
function isSafeExpression(expr) {
	const parts = expr.split('.');
	if (parts.length === 0)
		return false;
	return parts.every(part => {
		// only allows strings without escapes for [] syntax
		return /^[a-zA-Z_][a-zA-Z0-9_]*\s*(\[\s*([0-9]+|"[^"\\]*")\s*\])?$/.test(part);
	});
}

// Parses a Lua expression *if* it's something we can preview
function parsePreviewableExpr(expr) {
	if (expr.trim() === '' || expr.trim() === '...')
		return null;

	let colonOp = false;
	if (/:(\s*([a-zA-Z_][a-zA-Z0-9_]*\s*)?)$/.test(expr)) {
		// handle colon operator by pretending it's a dot
		colonOp = true;
		expr = expr.replace(/:(\s*([a-zA-Z_][a-zA-Z0-9_]*\s*)?)$/, ".$1");
	}

	// last part is treated specially, since it may be an unfinished expression
	const parts = expr.split('.');
	const last = parts.pop();
	const front = parts.join('.').trimStart();
	if (front === '' && !/^\s*\./.test(expr)) {
		// refers to _G
	} else if (!isSafeExpression(front)) {
		return null;
	}

	// indicates the part that would be replaced by tab completion
	let lastStart = expr.lastIndexOf('.') + 1;
	let lastEnd = expr.length;

	// Identifier
	if (last.trimEnd() === '') {
		// "foo." is different from "foo" since the user wants to see
		// suggestions inside the table.
		return { expr: front, index: null, lastStart, lastEnd, colonOp };
	}
	if (/^[a-zA-Z_][a-zA-Z0-9_]*\s*$/.test(last)) {
		return { expr: front, index: last, lastStart, lastEnd, colonOp };
	}
	if (colonOp)
		return null;
	// Array index (number)
	const frontDot = front ? (front + '.') : '';
	let m = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*\[\s*([0-9]+)\s*\]?$/.exec(last);
	if (m) {
		lastStart = expr.indexOf('[', lastStart);
		return {
			expr: frontDot + m[1],
			index: parseInt(m[2]),
			arrayIndex: true,
			lastStart,
			lastEnd
		};
	}
	// Array index (string)
	m = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*\[\s*"([^"\\]*)(|"\s*\]?)$/.exec(last);
	if (m) {
		lastStart = expr.indexOf('[', lastStart);
		return {
			expr: frontDot + m[1],
			index: m[2],
			arrayIndex: true,
			lastStart,
			lastEnd
		};
	}
	// Array index (unfinished)
	m = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*\[\s*$/.exec(last);
	if (m) {
		lastStart = expr.indexOf('[', lastStart);
		return {
			expr: frontDot + m[1],
			index: null,
			arrayIndex: true,
			lastStart,
			lastEnd
		};
	}
	return null;
}

// Find an expression that we can preview at the cursor position
// This can be a sub-string if the user is currently typing e.g. a function argument
function findPreviewableExpr(expr, findPos) {
	// First neutralize strings so we can do our regex hackery
	if (expr.indexOf('\\') != -1 || expr.indexOf('[[') != -1)
		return null;
	expr = expr
		.replace(/"[^"]*"/, (s) => "!".repeat(s.length))
		.replace(/'[^']*'/, (s) => "!".repeat(s.length));
	// Now try finding a place where a Lua expression could fit
	let last = 0, skipNext = false;
	const parts = [];
	const r = new RegExp(/[{}(),=]\s*/g);
	while ((m = r.exec(expr)) !== null) {
		const token = m[0].trim();
		if (skipNext) {
			skipNext = false;
		} else if (token === '=') {
			// expression can never be before =
		} else {
			parts.push({ start: last, end: m.index });
		}
		last = m.index + m[0].length;
		// an expression can never follow these
		if (token === '}' || token === ')')
			skipNext = true;
	}
	if (!skipNext && last != expr.length) {
		parts.push({ start: last, end: expr.length });
	}
	// Check if the part under the cursor is previewable and use that
	for (const p of parts) {
		//console.log(p, expr.substring(p.start, p.end));
		if (findPos >= p.start && findPos <= p.end) {
			let pExpr = parsePreviewableExpr(expr.substring(p.start, p.end));
			if (pExpr) {
				pExpr.lastStart += p.start;
				pExpr.lastEnd += p.start;
				if (findPos >= pExpr.lastStart && findPos <= pExpr.lastEnd)
					return pExpr;
			}
		}
	}
	return null;
}

// This is used to be decide if we should do a preview call while the user is
// still typing. Useful when the user starts typing "core." and then more letters.
function shouldPreviewSimilar(oldPExpr, newPExpr) {
	if (!oldPExpr || !newPExpr)
		return false;
	return oldPExpr.expr == newPExpr.expr && typeof(newPExpr.index) === 'string';
}

// Gets preview data from cache, if possible
function getCachedPreview(parsedExpr) {
	if (!parsedExpr)
		return null;
	if (!cachedPreviewData || cachedPreviewData.until < performance.now())
		return null;
	const { expr: expr2, index: index2, data } = cachedPreviewData;
	// Full match
	if (parsedExpr.expr == expr2 && parsedExpr.index == index2) {
		return data;
	}
	// If we unsuccessfully inspected "foo.b" before and the user now types for
	// "foo.ba", we can use the previous data to instantly know whether that
	// key exists in the table.
	if (parsedExpr.expr == expr2 && !data.was_indexed) {
		if (!parsedExpr.colonOp && data.type === 'table' && data.keys) {
			if (data.keys.indexOf(parsedExpr.index) == -1)
				return data;
		}
		if (parsedExpr.colonOp && data.meta) {
			if (data.meta.indexOf(parsedExpr.index) == -1)
				return data;
		}
	}
	// If we have successfully inspected "foo" before and the user now types
	// "foo." or "foo.a" we can instantly say which keys it has.
	const fakeExpr = (expr2 && index2) ? (expr2 + '.' + index2) : (expr2 || index2);
	if (fakeExpr == parsedExpr.expr && data.was_indexed && data.type === 'table' && data.keys) {
		if (data.keys.indexOf(parsedExpr.index) == -1) {
			let fakeData = structuredClone(data);
			fakeData.was_indexed = false; // we're pretending to look inside
			return fakeData;
		}
	}
	return null;
}

// Gets preview data using RPC
function getPreview(parsedExpr) {
	// we can't invalidate when Lua state changes or anything, so pick something short
	const PREVIEW_CACHE_DURATION = 5 * 1000;

	cancelPendingPreview();
	const ac = new AbortController();
	pendingPreview = ac;

	const p = new Promise((resolve, reject) => {
		socket.emit('rpc', {
			a: 'inspect',
			expr: parsedExpr.expr,
			index: parsedExpr.index
		}, (data) => {
			if (pendingPreview !== ac || ac.signal.aborted)
				return reject("raced");
			pendingPreview = null;
			if (data === null)
				return reject("timeout");
			if (!data.error) {
				cachedPreviewData = {
					expr: parsedExpr.expr,
					index: parsedExpr.index,
					data: data,
					until: performance.now() + PREVIEW_CACHE_DURATION,
				};
			}
			resolve(data);
		});
	});
	return p;
}

function cancelPendingPreview() {
	if (pendingPreview) {
		pendingPreview.abort();
		pendingPreview = null;
	}
}

function isLuaArray(keys) {
	// contiguous integer keys 1..n
	if (keys.some(k => typeof(k) !== 'number'))
		return false;
	const numericKeys = keys
		.filter(k => k >= 1)
		.sort((a, b) => a - b);
	return numericKeys.length === keys.length && numericKeys.every((v, i) => v === i + 1);
}

function formatLuaValue(value) {
	if (typeof(value) === 'string') {
		// FIXME: utf-8, escapes, everything to match Lua
		return JSON.stringify(value);
	} else if (value === null) {
		return 'nil';
	}
	// boolean or number
	return String(value);
}

function formatLuaValueDisplay(value, stringMaxLen = -1) {
	if (typeof(value) === 'string') {
		// FIXME: as above
		let text = JSON.stringify(value).replace(/\s+/g, ' ');
		// TODO truncate inside quotes and show entire len
		if (stringMaxLen > 0 && text.length > stringMaxLen) {
			text = text.substring(0, stringMaxLen) + '\u2026';
		}
		return '<span class="hljs-string">' + escapeHtml(text) + '</span>';
	} else if (value === null) {
		return '<span class="hljs-literal">nil</span>';
	} else if (typeof(value) === 'number') {
		return '<span class="hljs-number">' + String(value) + '</span>';
	} else if (typeof(value) === 'boolean') {
		return '<span class="hljs-literal">' + String(value) + '</span>';
	}
	return '???';
}

// Decides what to preview or tab-complete
function decidePreview(parsedExpr, data) {
	if (!data || data.error) {
		return null;
	}
	// stupid Lua interop issue: empty tables are null
	data.keys = data.keys || [];
	data.meta = data.meta || [];

	const getBestKeyMatch = (keys, typed) => {
		if (typed === null || typed === '') {
			// suggest if it's the only option
			return { keys: keys, best: (keys.length == 1 ? 0 : -1) };
		}

		// TODO: smarter filtering & ranking (substring, case-insensitive)
		typed = typed.toLocaleLowerCase();
		const tmp = keys.filter(k => k.toLocaleLowerCase().startsWith(typed));
		if (tmp.length > 0) {
			return { keys: tmp, best: 0 };
		}
		return { keys, best: -1 };
	};

	let ret = {
		wasIndexed: data.was_indexed || false,
	};
	// We can only filter keys and make suggestions when the user hasn't already
	// typed a valid expression.
	const canSuggestKey = !ret.wasIndexed;
	if (data.type === 'nil') {
		ret.text = 'nil';
	} else if (data.type === 'string' || data.type === 'number' || data.type === 'boolean') {
		ret.rawValue = data.value;
	} else if (data.as_string) {
		ret.text = data.as_string;
	} else if (data.type === 'table') {
		if (data.other_keys) {
			// we can't represent non-number non-string keys, so refuse
			ret.text = '<table>';
		} else if (data.keys.length == 0) {
			ret.text = '{}';
		} else if (isLuaArray(data.keys)) {
			if (data.keys.length <= 3)
				ret.tableKeys = data.keys;
			else
				ret.tableRange = [1, data.keys.length];
		} else if (data.keys.length > 0) {
			const index = parsedExpr.index;
			let matches = data.keys;
			matches.sort();
			if (canSuggestKey) {
				// show only keys matching the syntax
				const oldLen = matches.length;
				if (parsedExpr.arrayIndex) {
					if (parsedExpr.index !== null)
						matches = matches.filter(k => typeof(k) === typeof(parsedExpr.index));
				} else {
					// only valid identifiers
					matches = matches.filter(k => typeof(k) === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k));
				}
				let suggestIndex = -1;
				if (index === null || index === '') {
					// when not filtering this is used to inform the user about
					// keys they can't see
					ret.tableKeysHidden = oldLen - matches.length;
				} else if (typeof(index) === 'string') {
					({ keys: matches, best: suggestIndex } = getBestKeyMatch(matches, index));
				}

				// put together tab-completion suggestion
				if (parsedExpr.arrayIndex) {
					if (suggestIndex >= 0) {
						ret.tableKeyHilit = suggestIndex;
						ret.tabComplete = {
							text: '[' + formatLuaValue(matches[suggestIndex]) + ']'
						};
					}
				} else {
					if (suggestIndex >= 0) {
						ret.tableKeyHilit = suggestIndex;
						ret.tabComplete = {
							text: matches[suggestIndex]
						};
					}
				}
			}
			ret.tableKeys = matches;
		}
	}
	// tab-complete metamethods
	if (parsedExpr.colonOp && data.meta.length > 0 && canSuggestKey) {
		let funcs = data.meta;
		funcs = funcs.filter(k => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k));
		let suggestIndex = -1;
		({ keys: funcs, best: suggestIndex } = getBestKeyMatch(funcs, parsedExpr.index));
		// TODO functions should be visually different, in general
		// then we can also apply the "()" suffix everywhere
		ret.tableKeys = funcs;
		if (suggestIndex >= 0) {
			ret.tableKeyHilit = suggestIndex;
			ret.tabComplete = {
				text: funcs[suggestIndex] + '()',
				offset: -1, // leaves cursor inside call
			};
		}
	}
	// tab-complete function calls (if entire name already typed)
	if (!canSuggestKey && ret.wasIndexed && data.callable) {
		ret.tabComplete = {
			text: '()',
			offset: -1,
			append: true
		};
	}
	return ret;
}

// Turns preview data into displayable text
function formatPreview(parsedExpr, previewData) {
	if (!previewData) {
		return '';
	}

	const PREVIEW_MAX_LEN = 520;
	let ret = '';
	if (previewData.rawValue !== undefined) {
		ret = formatLuaValueDisplay(previewData.rawValue, PREVIEW_MAX_LEN);
	} else if (previewData.tableKeys !== undefined) {
		let keys = previewData.tableKeys;
		let line = '';
		let length = 0;
		for (const [i, key] of keys.entries()) {
			if (length != 0) {
				line += ', ';
				length += 2;
			}
			if (length > PREVIEW_MAX_LEN) {
				line += '\u2026';
				break;
			}
			length += key.length; // this counts the actually visible length (roughly)

			let keyHtml;
			if (parsedExpr.arrayIndex) {
				// need to format keys like proper Lua values
				keyHtml = formatLuaValueDisplay(key, PREVIEW_MAX_LEN / 10);
			} else {
				keyHtml = escapeHtml(key);
			}
			if (i === previewData.tableKeyHilit)
				keyHtml = '<span class="tabcomplete">' + keyHtml + '</span>';
			line += keyHtml;
		}
		if (previewData.tableKeysHidden) {
			const n = previewData.tableKeysHidden;
			line += (length > 0 ? ', ' : '') + `(${n} other keys not shown)`;
		}
		ret = '[ ' + line + ' ]';
	} else if (previewData.tableRange !== undefined) {
		const r = previewData.tableRange;
		ret = `[ ${formatLuaValueDisplay(r[0])} \u2026 ${formatLuaValueDisplay(r[1])} ]`;
	} else {
		ret = escapeHtml(previewData.text || '???');
	}

	// indicate whether we're inside the table, or are showing stuff from the parent table
	let prefix = escapeHtml(previewData.wasIndexed ? '= ' : '? ');
	ret = prefix + ret;

	return ret;
}

function evaluateExpression(cmdStr) {
	const cmd = hljs.highlight(cmdStr, {language: 'lua', ignoreIllegals: true});
	const promptNode = appendToOutput('\u2b62\u00a0' + cmd.value, '', null, true);

	// FIXME: should probably do this using css instead?
	const pre = '\u2b60\u00a0';

	socket.emit('rpc', { a: 'eval', code: cmdStr }, (data) => {
		if (data === null) {
			appendToOutput(`${pre}Timeout`, 'error', promptNode);
		} else if (data.syntax_error) {
			appendToOutput(`${pre}Syntax error: ${data.syntax_error}`, 'error', promptNode);
		} else if (data.runtime_error) {
			appendToOutput(`${pre}Runtime error: ${data.runtime_error}`, 'error', promptNode);
		} else {
			const ret = hljs.highlight(String(data.ret), {language: 'lua', ignoreIllegals: true});
			appendToOutput(pre + ret.value, '', promptNode, true);
		}
	});
}

function updatePreview(pExpr) { // instant
	if (!pExpr) {
		lastPreview = null;
		preview.textContent = '';
		return true;
	}
	const data = getCachedPreview(pExpr);
	if (data) {
		clearTimeout(debounceTimeout);
		debounceTimeout = undefined;
		const pData = decidePreview(pExpr, data);
		lastPreview = { pExpr, pData };
		DEBUG && console.log(lastPreview, "(from cache)");
		preview.innerHTML = formatPreview(pExpr, pData);
		return true;
	}
	return false;
}

function triggerTabComplete() {
	const TAB_COMPLETE_DELAY = 200;

	// if we can update the preview without delay, do that immediately
	const valOld = input.value;
	const pExprOld = findPreviewableExpr(valOld, input.selectionEnd);
	if (updatePreview(pExprOld)) {
		cancelPendingPreview();
		return;
	}

	// old suggestion is invalidated immediately, but preview stays
	if (lastPreview && lastPreview.pData) {
		const { pExpr, pData } = lastPreview;
		delete pData.tabComplete;
		preview.innerHTML = formatPreview(pExpr, pData);
	}

	// else wait and update afterwards
	if (debounceTimeout)
		return;
	debounceTimeout = setTimeout(() => {
		debounceTimeout = undefined;

		const val = input.value;
		const pExpr = findPreviewableExpr(val, selectionEnd = input.selectionEnd);
		if (updatePreview(pExpr)) {
			cancelPendingPreview();
			return;
		}
		if (valOld != val && !shouldPreviewSimilar(pExprOld, pExpr)) {
			// user is still typing, wait more.
			triggerTabComplete();
			return;
		}
		getPreview(pExpr).then(data => {
			const pData = decidePreview(pExpr, data);
			lastPreview = { pExpr, pData };
			DEBUG && console.log(lastPreview);
			preview.innerHTML = formatPreview(pExpr, pData);
		}).catch((err) => {
			DEBUG && console.log("preview error:", err);
		});
	}, TAB_COMPLETE_DELAY);
}

function applyTabComplete() {
	const val = input.value;
	if (!lastPreview || !lastPreview.pData)
		return false;
	const { pExpr } = lastPreview;
	const { tabComplete } = lastPreview.pData;
	if (!tabComplete)
		return false;
	const tail = val.substring(pExpr.lastEnd);
	if (tabComplete.append)
		input.value = val.substring(0, pExpr.lastEnd) + tabComplete.text + tail;
	else
		input.value = val.substring(0, pExpr.lastStart) + tabComplete.text + tail;
	// move cursor
	const off = (tabComplete.offset || 0) - tail.length;
	input.setSelectionRange(input.value.length + off, input.value.length + off);
	triggerTabComplete();
}

input.addEventListener('input', () => {
	triggerTabComplete();
});

input.addEventListener('selectionchange', () => {
	triggerTabComplete();
});

input.addEventListener('keydown', (ev) => {
	if (ev.key === 'Enter') {
		const cmd = input.value.trim();
		if (cmd) {
			if (history.length == 0 || history[history.length - 1] != cmd) {
				history.push(cmd);
				saveHistory();
			}
			historyIndex = history.length;
			evaluateExpression(cmd);
		}
		input.value = '';
		triggerTabComplete(); // clears the preview
	} else if (ev.key === 'ArrowUp') {
		if (historyIndex > 0) {
			historyIndex--;
			input.value = history[historyIndex];
			triggerTabComplete();
		}
		ev.preventDefault();
	} else if (ev.key === 'ArrowDown') {
		if (historyIndex < history.length - 1) {
			historyIndex++;
			input.value = history[historyIndex];
		} else {
			historyIndex = history.length;
			input.value = '';
		}
		triggerTabComplete();
		ev.preventDefault();
	} else if (ev.key === 'Tab') {
		ev.preventDefault();
		applyTabComplete();
	}
});

preview.addEventListener('click', (ev) => {
	// Clicking the highlighted part also triggers tab completion
	if (ev.target.closest(".tabcomplete")) {
		applyTabComplete();
	}
});

output.addEventListener('mouseup', () => {
	// Focus the input box, but without breaking text selection
	if (window.getSelection().isCollapsed) {
		input.focus();
	}
});

loadHistory();
updateOnlineStatus();

})();
