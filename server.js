const express = require('express');
const socketio = require('socket.io');
const http = require('http');

const DEBUG = false;
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
let lastOnlineStatus = null;

io.on('connection', (socket) => {
	if (lastOnlineStatus)
		socket.emit('online_status', lastOnlineStatus);

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
let pendingTimeout;
let onlineStatusReset;

function onPollRequestCompleted() {
	// If client doesn't re-poll within this time, consider it disconnected
	clearTimeout(onlineStatusReset);
	onlineStatusReset = setTimeout(() => {
		onlineStatusReset = undefined;
		lastOnlineStatus = null;
		io.emit('online_status', lastOnlineStatus);
		DEBUG && console.log("online reset");
	}, RPC_TIMEOUT);
}

app.get('/poll', (req, res) => {
	// Let's not break anything if someone clicks on the link
	const ua = req.header("user-agent");
	if (!ua || ua.startsWith("Mozilla/")) {
		res.status(400).type('html').send('<a href="/">Go here</a>');
		return;
	}

	if (pendingRes !== null) {
		// Disconnect other client
		DEBUG && console.log("poll had conflict");
		clearTimeout(pendingTimeout);
		pendingTimeout = undefined;
		pendingRes.status(409).send("Polling conflict");
		pendingRes = null;
	}

	// Handle online status
	clearTimeout(onlineStatusReset);
	onlineStatusReset = undefined;
	const newOnlineStatus = ua.replace(/^([^/]+)\/([^\s]+)\s+.*$/, '$1 $2');
	if (lastOnlineStatus !== newOnlineStatus) {
		lastOnlineStatus = newOnlineStatus;
		io.emit('online_status', lastOnlineStatus);
		DEBUG && console.log("online ok");
	}

	if (messageQueue.length > 0) {
		DEBUG && console.log("poll finish (immediate)");
		res.json(messageQueue);
		messageQueue = [];
		onPollRequestCompleted();
		return;
	}

	pendingRes = res;
	pendingTimeout = setTimeout(() => {
		DEBUG && console.log("poll finish (timeout)");
		// Return nothing after timeout expiry
		if (!pendingRes) return;
		pendingRes.json([]);
		pendingRes = null;
		pendingTimeout = undefined;
		onPollRequestCompleted();
	}, LONG_POLL_TIMEOUT);

	req.on('close', () => {
		if (pendingRes === res) {
			DEBUG && console.log("poll request closed");
			pendingRes = null;
			onPollRequestCompleted();
		}
		clearTimeout(pendingTimeout);
		pendingTimeout = undefined;
	});
});

function pushToQueue(message) {
	messageQueue.push(message);

	if (!pendingRes) return;

	// Remove timeout and deliver message to waiting client
	if (pendingTimeout) {
		clearTimeout(pendingTimeout);
		pendingTimeout = undefined;
	}
	DEBUG && console.log("poll finish (delay)");
	pendingRes.json(messageQueue);
	messageQueue = [];
	pendingRes = null;
	onPollRequestCompleted();
}

// Static files for frontend
app.use(express.static('public'));

const PORT = 3001;
http_server.listen(PORT, 'localhost', () => {
	console.log(`Server running on port ${PORT}`);
});
