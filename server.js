const express = require('express');
const socketio = require('socket.io');
const http = require('http');

const MAX_RPC_ID = 0x1000000;
const LONG_POLL_TIMEOUT = 98 * 1000;
const MAX_RPC_SIZE = 42 * 1024 * 1024; // MB
const RPC_TIMEOUT = 2.5 * 1000;

const app = express();
const http_server = http.createServer(app);
const io = new socketio.Server(http_server, {maxHttpBufferSize: MAX_RPC_SIZE});

app.use(express.json({limit: MAX_RPC_SIZE}));

app.get('/ping', (req, res) => {
	res.status(204).send();
});

// RPC via websocket (used by frontend)
let rpcID = 1;

io.on('connection', (socket) => {
	socket.on('rpc', (message, callback) => {
		if (typeof(message) !== 'object' || message === null) {
			console.error("Type mismatch: expected object", message);
			return;
		}

		const myID = rpcID;
		rpcID = (rpcID + 1) % MAX_RPC_ID;
		message.id = myID;
		pushToQueue(message);

		waitForResponse(myID, RPC_TIMEOUT).then((response) => {
			delete incomingMessages[myID];
			callback(response);
		}).catch((_) => {
			// Remove from queue
			messageQueue = messageQueue.filter(it => it.id != myID);
			console.error(`No response from client for ${myID}`);
			callback(null);
		});
	});
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
	if (!Array.isArray(req.body)){
		res.status(400).send();
		return;
	}
	const events = [];
	for (const message of req.body) {
		// id => RPC reply
		if (message.id) {
			if (incomingMessages[message.id] !== undefined) {
				console.warn(`Ignoring duplicate reply for ${message.id}`);
				continue;
			}
			incomingMessages[message.id] = message;
			delete message['id'];
		} else if (message.event) {
			events.push(message);
		} else {
			res.status(400).send();
			return;
		}
	}
	if (events.length > 0)
		io.emit('event', events);
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
http_server.listen(PORT, 'localhost', () => {
	console.log(`Server running on port ${PORT}`);
});
