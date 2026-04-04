const express = require('express');
const app = express();

const MAX_RPC_ID = 0x1000000;
const LONG_POLL_TIMEOUT = 98 * 1000;
const RPC_TIMEOUT = 2.5 * 1000;

app.use(express.json({limit: '42MB'}));

app.get('/ping', (req, res) => {
	res.status(204).send();
});

// RPC endpoint (used by frontend)
// future TODO: websocket
let rpcID = 1;

app.post('/rpc', async (req, res) => {
	const message = req.body;
	if (typeof(message) !== 'object' || message === null) {
		res.status(400).send("Type mismatch: expected object");
		return;
	}

	const myID = rpcID;
	rpcID = (rpcID + 1) % MAX_RPC_ID;
	message.id = myID;
	pushToQueue(message);

	try {
		const response = await waitForResponse(myID, RPC_TIMEOUT);
		delete incomingMessages[myID];
		res.json(response);
	} catch (err) {
		delete incomingMessages[myID];
		messageQueue = messageQueue.filter(it => it.id != myID);
		res.status(504).send("No response from client");
	}
});

function waitForResponse(id, timeout) {
	return new Promise((resolve, reject) => {
		const endTime = performance.now() + timeout;
		// FIXME: this can be solved better without polling
		const checkInterval = setInterval(() => {
			if (incomingMessages[id]) {
				clearInterval(checkInterval);
				resolve(incomingMessages[id]);
			} else if (performance.now() >= endTime) {
				clearInterval(checkInterval);
				reject(new Error("Timeout"));
			}
		}, 10);
	});
}

// Message queue from Luanti client
let incomingMessages = {};
app.post('/push', (req, res) => {
	const message = req.body;
	if (!message.id) {
		res.status(400).send("Bad Request: missing id");
		return;
	}
	if (incomingMessages[message.id] !== undefined) {
		res.status(409).send("Duplicate message id");
		return;
	}
	incomingMessages[message.id] = message;
	delete message['id'];
	res.status(200).send();
});

// Message queue to Luanti client
let messageQueue = [];
let pendingRes = null;
let pendingTimeout = null;

app.get('/poll', (req, res) => {
	// Let's not break anything if someone clicks on the link
	if (req.header("user-agent").startsWith("Mozilla/")) {
		res.status(400).type('html').send('<a href="/">Go here</a>');
		return;
	}

	if (pendingRes !== null) {
		// Disconnect other client
		clearTimeout(pendingTimeout);
		pendingTimeout = null;
		pendingRes.status(409).send("Polling conflict");
		pendingRes = null;
	}

	if (messageQueue.length > 0) {
		res.json(messageQueue);
		messageQueue = [];
		return;
	}

	pendingRes = res;
	pendingTimeout = setTimeout(() => {
		// Return nothing after timeout expiry
		if (!pendingRes) return;
		pendingRes.json([]);
		pendingRes = null;
		pendingTimeout = null;
	}, LONG_POLL_TIMEOUT);

	req.on('close', () => {
		if (pendingRes === res)
			pendingRes = null;
		if (pendingTimeout) {
			clearTimeout(pendingTimeout);
			pendingTimeout = null;
		}
	});
});

function pushToQueue(message) {
	messageQueue.push(message);

	if (!pendingRes) return;

	// Remove timeout and deliver message to waiting client
	if (pendingTimeout) {
		clearTimeout(pendingTimeout);
		pendingTimeout = null;
	}

	pendingRes.json(messageQueue);
	messageQueue = [];
	pendingRes = null;
}

// Static files for frontend
app.use(express.static('public'));

const PORT = 3001;
app.listen(PORT, 'localhost', () => {
	console.log(`Server running on port ${PORT}`);
});
