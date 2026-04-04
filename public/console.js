(() => {

const DEBUG = false;
const output = document.getElementById('output');
const input = document.getElementById('input');
const preview = document.getElementById('preview');

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

let debounceTimeout; // for preview fetch
let lastPreview = null; // { pExpr, pData }
let pendingPreview = null;
let cachedPreviewData = null; // { expr, index, data, until }

function escapeHtml(text) {
	if (text == null) return '';
	return String(text)
		.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function appendToOutput(text, className = '', after = null) {
	const div = document.createElement('div');
	div.innerHTML = escapeHtml(text);
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

// Allows simple table or array access, no function calls or anything
// FIXME: would need to rewrite this to support foo["b"]["a"]
function isSafeExpression(expr) {
	const parts = expr.split('.');
	if (parts.length === 0) {
		return false;
	}
	return parts.every(part => {
		// only allows strings without escapes for [] syntax
		return /^[a-zA-Z_][a-zA-Z0-9_]*\s*(\[\s*([0-9]+|"[^"\\]*")\s*\])?$/.test(part);
	});
}

// Parses a Lua expression *if* it's something we can preview
// FIXME: should replace this with real lexing/parsing, probably
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
async function getPreview(parsedExpr) {
	// we can't invalidate when Lua state changes or anything, so pick something short
	const PREVIEW_CACHE_DURATION = 5 * 1000;
	if (pendingPreview) {
		pendingPreview.abort();
		pendingPreview = null;
	}
	const ac = new AbortController();
	pendingPreview = ac;
	try {
		const res = await fetch('/rpc', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			signal: pendingPreview.signal,
			body: JSON.stringify({
				a: 'inspect',
				expr: parsedExpr.expr,
				index: parsedExpr.index
			})
		});
		if (pendingPreview !== ac)
			throw new Error("raced");
		pendingPreview = null;
		if (!res.ok)
			throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		if (data && !data.error) {
			cachedPreviewData = {
				expr: parsedExpr.expr,
				index: parsedExpr.index,
				data: data,
				until: performance.now() + PREVIEW_CACHE_DURATION,
			};
		}
		return data;
	} catch (err) {
		console.log("preview error", err);
		return null;
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
	if (typeof value === 'string') {
		// FIXME: utf-8, escapes, everything to match Lua
		return JSON.stringify(value);
	} else if (value === null) {
		return 'nil';
	}
	return String(value);
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
    // We should only filter keys and make suggestions when the user
	// hasn't already typed a valid expression
	const shouldSuggestKey = !ret.wasIndexed;
	if (data.type === 'nil') {
		ret.text = 'nil';
	} else if (data.type === 'string') {
		ret.stringValue = data.value;
	} else if (data.value) {
		ret.text = String(data.value); // booleans or numbers
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
				ret.text = `[ 1 \u2026 ${data.keys.length} ]`;
		} else if (data.keys.length > 0) {
			let matches = data.keys;
			let suggestIndex = -1;
			matches.sort();
			if (shouldSuggestKey) {
				// show only keys matching the syntax
				const oldLen = matches.length;
				if (parsedExpr.arrayIndex) {
					if (parsedExpr.index !== null)
						matches = matches.filter(k => typeof(k) === typeof(parsedExpr.index));
				} else {
					// only valid identifiers
					matches = matches.filter(k => typeof(k) === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k));
				}
				const index = parsedExpr.index;
				if (index === null || index === '') {
					// when not filtering this is used to inform the user about
					// keys they can't see
					ret.tableKeysHidden = oldLen - matches.length; 
				} else if (typeof(index) === 'string') {
					({ keys: matches, best: suggestIndex } = getBestKeyMatch(matches, index));
				}
			} else {
				// TODO: tab-complete final ] or "] if key exists
			}
			ret.tableKeys = matches;
			// put together tab-completion suggestion
			if (parsedExpr.arrayIndex) {
				if (suggestIndex >= 0) {
					ret.tableKeyHilit = suggestIndex;
					ret.tabComplete = '[' + formatLuaValue(matches[suggestIndex]) + ']';
				}
			} else {
				if (suggestIndex >= 0) {
					ret.tableKeyHilit = suggestIndex;
					ret.tabComplete = matches[suggestIndex];
				}
			}
		}
	}
	// tab-complete metamethods
	if (parsedExpr.colonOp && data.meta.length > 0 && shouldSuggestKey) {
		let funcs = data.meta;
		funcs = funcs.filter(k => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k));
		let suggestIndex = -1;
		({ keys: funcs, best: suggestIndex } = getBestKeyMatch(funcs, parsedExpr.index));
		// TODO functions should be visually different, in general
		// then we can also apply the "()" suffix everywhere
		ret.tableKeys = funcs;
		if (suggestIndex >= 0) {
			ret.tableKeyHilit = suggestIndex;
			ret.tabComplete = funcs[suggestIndex] + '()';
			ret.tabCompleteOffset = -1; // leaves cursor inside call
		}
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
	if (previewData.stringValue) {
		// also normalizes whitespace (incl. newlines)
		let text = formatLuaValue(previewData.stringValue).replace(/\s+/g, ' ');
		// TODO truncate inside quotes and show entire len
		if (text.length > PREVIEW_MAX_LEN) {
			text = text.substring(0, PREVIEW_MAX_LEN) + '\u2026';
		}

		ret = escapeHtml(text);
	} else if (previewData.tableKeys) {
		let keys;
		if (parsedExpr.arrayIndex) {
			// need to format keys like proper Lua values
			keys = previewData.tableKeys.map(k => formatLuaValue(k));
		} else {
			keys = previewData.tableKeys;
		}
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
			if (i === previewData.tableKeyHilit)
				line += '<span class="tabcomplete">' + escapeHtml(key) + '</span>';
			else
				line += escapeHtml(key);
			length += key.length;
		}
		if (previewData.tableKeysHidden) {
			const n = previewData.tableKeysHidden;
			line += (length > 0 ? ', ' : '') + `(${n} other keys not shown)`;
		}
		ret = '[ ' + line + ' ]';
	} else {
		ret = escapeHtml(previewData.text || '???');
	}

	// indicate whether we're inside the table, or are showing stuff from the parent table
	let prefix = escapeHtml(previewData.wasIndexed ? '= ' : '? ');
	ret = prefix + ret;

	return ret;
}

function evaluateExpression(cmd) {
	const promptNode = appendToOutput(`> ${cmd}`, 'prompt');

	fetch('/rpc', {
		method: 'POST',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify({ a: 'eval', code: cmd })
	})
	.then(async (res) => {
		if (!res.ok) {
			throw new Error(`HTTP ${res.status}`);
		}
		return res.json();
	})
	.then((data) => {
		if (data.syntax_error) {
			appendToOutput(`Syntax error: ${data.syntax_error}`, 'error', promptNode);
		} else if (data.runtime_error) {
			appendToOutput(`Runtime error: ${data.runtime_error}`, 'error', promptNode);
		} else {
			appendToOutput(String(data.ret), '', promptNode);
		}
	})
	.catch((err) => {
		appendToOutput(`${err.message}`, 'error', promptNode);
	});
}

function clearPreview() {
	if (pendingPreview) {
		pendingPreview.abort();
		pendingPreview = null;
	}
	lastPreview = null;
	preview.textContent = '';
}

function updatePreview(pExpr) { // instant
	if (!pExpr) {
		clearPreview();
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
	const val = input.value;
	if (updatePreview(parsePreviewableExpr(val)))
		return;

	// old suggestion is invalidated immediately, but preview stays
	if (lastPreview && lastPreview.pData) {
		delete lastPreview.pData.tabComplete;
		preview.innerHTML = formatPreview(lastPreview.pExpr, lastPreview.pData);
	}

	// else wait and update afterwards
	if (debounceTimeout)
		return;
	debounceTimeout = setTimeout(() => {
		debounceTimeout = undefined;

		const newVal = input.value;
		const pExpr = parsePreviewableExpr(newVal);
		if (updatePreview(pExpr))
			return;
		if (val != newVal && !shouldPreviewSimilar(parsePreviewableExpr(val), pExpr)) {
			// user is still typing, wait more.
			triggerTabComplete();
			return;
		}
		getPreview(pExpr).then(data => {
			const pData = decidePreview(pExpr, data);
			lastPreview = { pExpr, pData };
			DEBUG && console.log(lastPreview);
			preview.innerHTML = formatPreview(pExpr, pData);
		});
	}, TAB_COMPLETE_DELAY);
}

input.addEventListener('input', () => {
	triggerTabComplete();
});

input.addEventListener('keydown', (ev) => {
	if (ev.key === 'Enter') {
		const cmd = input.value.trim();
		if (cmd) {
			history.push(cmd);
			historyIndex = history.length;
			saveHistory();
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
		const val = input.value;
		if (lastPreview) {
			const { pExpr, pData } = lastPreview;
			if (pData && pData.tabComplete) {
				input.value = val.substring(0, pExpr.lastStart) + pData.tabComplete + val.substring(pExpr.lastEnd);
				// move cursor to end
				const off = pData.tabCompleteOffset || 0;
				input.setSelectionRange(input.value.length + off, input.value.length + off);
				triggerTabComplete();
			}
		}
	}
});

loadHistory();

})();
