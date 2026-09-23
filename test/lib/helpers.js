'use strict';

/**
 * Shared helpers for the ws-server tests.
 *
 * The tests talk the wire protocol directly (`ws` package) instead of using
 * `@iobroker/ws`, so that every single frame can be inspected and malformed
 * input can be injected.
 */

const http = require('node:http');
const WebSocket = require('ws');

const { SocketIO, Socket } = require('../../build');

/** Message types of the ioBroker web socket protocol */
const MESSAGE_TYPES = {
    MESSAGE: 0,
    PING: 1,
    PONG: 2,
    CALLBACK: 3,
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Default time the helpers wait for an expected frame */
const DEFAULT_TIMEOUT = 5000;

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Replace console.error/console.warn/console.log for the duration of `fn`
 * and return everything that was written to them.
 */
async function captureConsole(fn) {
    const captured = { log: [], warn: [], error: [] };
    const original = { log: console.log, warn: console.warn, error: console.error };

    console.log = (...args) => captured.log.push(args.join(' '));
    console.warn = (...args) => captured.warn.push(args.join(' '));
    console.error = (...args) => captured.error.push(args.join(' '));

    try {
        await fn();
    } finally {
        console.log = original.log;
        console.warn = original.warn;
        console.error = original.error;
    }

    return captured;
}

/**
 * A raw protocol client.
 *
 * It only knows the wire format, it has no reconnect/ping logic of its own,
 * so the tests stay in full control of what is sent and when.
 */
class TestClient {
    constructor(url, wsOptions) {
        this.url = url;
        this.ws = new WebSocket(url, wsOptions);
        /** Every frame the server sent, as `{ frame, isBinary, claimed }` */
        this.frames = [];
        /** Close event of the underlying socket, if it was closed already */
        this.closeEvent = null;
        this.lastError = null;

        this._nextId = 0;
        this._pending = new Map();
        this._waiters = [];
        this._handlers = new Map();

        this.opened = new Promise((resolve, reject) => {
            this.ws.on('open', resolve);
            this.ws.on('error', reject);
        });
        // Never let an unhandled rejection kill the test process. The tests
        // that care about a failed handshake await `opened` themselves.
        this.opened.catch(() => {});

        this.closed = new Promise(resolve => {
            this.ws.on('close', (code, reason) => {
                this.closeEvent = { code, reason: reason ? reason.toString() : '' };
                this._rejectAllWaiters(new Error(`Connection closed with code ${code}`));
                resolve(this.closeEvent);
            });
        });

        this.ws.on('error', error => {
            this.lastError = error;
        });

        this.ws.on('message', (data, isBinary) => {
            if (isBinary) {
                this._onFrame(data, true);
                return;
            }
            let frame;
            try {
                frame = JSON.parse(data.toString());
            } catch {
                frame = data.toString();
            }
            this._onFrame(frame, false);
        });
    }

    get readyState() {
        return this.ws.readyState;
    }

    _onFrame(frame, isBinary) {
        const entry = { frame, isBinary, claimed: false };
        this.frames.push(entry);

        if (!isBinary && Array.isArray(frame)) {
            const [type, id, name, args] = frame;

            if (type === MESSAGE_TYPES.CALLBACK && this._pending.has(id)) {
                const pending = this._pending.get(id);
                this._pending.delete(id);
                entry.claimed = true;
                clearTimeout(pending.timer);
                pending.resolve({ name, args: args || [] });
                return;
            }

            if (type === MESSAGE_TYPES.MESSAGE) {
                for (const cb of this._handlers.get(name) || []) {
                    cb(...(args || []));
                }
            }
        }

        this._flushWaiters();
    }

    _flushWaiters() {
        for (const waiter of [...this._waiters]) {
            const entry = this.frames.find(e => !e.claimed && waiter.match(e));
            if (entry) {
                entry.claimed = true;
                this._waiters.splice(this._waiters.indexOf(waiter), 1);
                clearTimeout(waiter.timer);
                waiter.resolve(entry.frame);
            }
        }
    }

    _rejectAllWaiters(error) {
        for (const waiter of this._waiters.splice(0)) {
            clearTimeout(waiter.timer);
            waiter.reject(error);
        }
        for (const pending of this._pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this._pending.clear();
    }

    /** Wait for the first not yet consumed frame matching `match` */
    waitForFrame(match, description, timeout = DEFAULT_TIMEOUT) {
        return new Promise((resolve, reject) => {
            const waiter = { match, resolve, reject };
            waiter.timer = setTimeout(() => {
                const pos = this._waiters.indexOf(waiter);
                if (pos !== -1) {
                    this._waiters.splice(pos, 1);
                }
                reject(
                    new Error(
                        `Timeout while waiting for ${description}. Received frames: ` +
                            JSON.stringify(this.frames.map(e => e.frame)),
                    ),
                );
            }, timeout);
            this._waiters.push(waiter);
            this._flushWaiters();
        });
    }

    /** Wait for a `MESSAGE` frame with the given event name and return its arguments */
    async waitForMessage(name, timeout) {
        const frame = await this.waitForFrame(
            e => Array.isArray(e.frame) && e.frame[0] === MESSAGE_TYPES.MESSAGE && e.frame[2] === name,
            `message "${name}"`,
            timeout,
        );
        return frame[3] || [];
    }

    /** Wait for the `___ready___` message the server sends after the handlers are installed */
    waitForReady(timeout) {
        return this.waitForMessage('___ready___', timeout);
    }

    /** Wait for a frame of the given type, e.g. `MESSAGE_TYPES.PING` */
    waitForType(type, timeout) {
        return this.waitForFrame(e => Array.isArray(e.frame) && e.frame[0] === type, `frame of type ${type}`, timeout);
    }

    /** Install a handler for a server message */
    on(name, cb) {
        if (!this._handlers.has(name)) {
            this._handlers.set(name, []);
        }
        this._handlers.get(name).push(cb);
        return this;
    }

    /** Send a normal message without expecting an answer */
    emit(name, ...args) {
        this._nextId++;
        if (args.length) {
            this.sendRaw(JSON.stringify([MESSAGE_TYPES.MESSAGE, this._nextId, name, args]));
        } else {
            this.sendRaw(JSON.stringify([MESSAGE_TYPES.MESSAGE, this._nextId, name]));
        }
        return this._nextId;
    }

    /** Send a message and wait for the callback answer. Resolves with `{ id, name, args }` */
    requestFull(name, ...args) {
        this._nextId++;
        const id = this._nextId;

        const promise = new Promise((resolve, reject) => {
            const pending = { resolve, reject };
            pending.timer = setTimeout(() => {
                this._pending.delete(id);
                reject(new Error(`Timeout while waiting for the answer of "${name}"`));
            }, DEFAULT_TIMEOUT);
            this._pending.set(id, pending);
        });

        this.sendRaw(JSON.stringify([MESSAGE_TYPES.CALLBACK, id, name, args]));

        return promise.then(answer => ({ ...answer, id }));
    }

    /** Send a message and wait for the callback answer. Resolves with the answer arguments */
    request(name, ...args) {
        return this.requestFull(name, ...args).then(answer => answer.args);
    }

    /** Answer every ping of the server with a pong, like a real client does */
    autoPong() {
        this.ws.on('message', (data, isBinary) => {
            if (isBinary) {
                return;
            }
            try {
                if (JSON.parse(data.toString())[0] === MESSAGE_TYPES.PING) {
                    this.sendRaw(JSON.stringify([MESSAGE_TYPES.PONG]));
                }
            } catch {
                // not our frame
            }
        });
        return this;
    }

    /** Send a protocol ping and wait for the pong */
    async ping() {
        this.sendRaw(JSON.stringify([MESSAGE_TYPES.PING]));
        return this.waitForType(MESSAGE_TYPES.PONG);
    }

    sendRaw(data) {
        this.ws.send(data);
        return this;
    }

    close() {
        this.ws.close();
        return this.closed;
    }

    terminate() {
        this.ws.terminate();
    }
}

/**
 * Start an HTTP server with a `SocketIO` instance on an ephemeral port.
 *
 * @param options.onConnection handler installed for the "connection" event. Default: call `initDone()`
 * @param options.noConnectionHandler do not install a "connection" handler at all
 * @param options.use middlewares registered via `socketServer.use()`
 */
async function createTestServer(options = {}) {
    /** All sockets the server created, in order of connection */
    const sockets = [];
    /** Everything that was reported via the server "error" event */
    const errors = [];

    const webServer = http.createServer((_req, res) => {
        res.writeHead(200);
        res.end('Hello, World!');
    });

    // Upgraded sockets are no longer tracked by the HTTP server, and a request
    // that is stuck in an unanswered middleware is never upgraded at all. Keep
    // the raw sockets so that destroy() can always tear everything down.
    const rawSockets = new Set();
    webServer.on('connection', socket => {
        rawSockets.add(socket);
        socket.on('close', () => rawSockets.delete(socket));
    });

    const socketServer = new SocketIO(webServer);
    socketServer.on('error', (name, error) => errors.push({ name, error: error?.message || error }));

    for (const middleware of options.use || []) {
        socketServer.use(middleware);
    }

    if (!options.noConnectionHandler) {
        const onConnection = options.onConnection || ((_socket, initDone) => initDone && initDone());
        socketServer.on('connection', (socket, initDone) => {
            sockets.push(socket);
            onConnection(socket, initDone);
        });
    }

    await new Promise(resolve => webServer.listen(0, '127.0.0.1', resolve));
    const port = webServer.address().port;

    const clients = [];

    return {
        webServer,
        socketServer,
        sockets,
        errors,
        port,
        url: `ws://127.0.0.1:${port}`,

        /** The socket of the connection that was established last */
        get socket() {
            return sockets[sockets.length - 1];
        },

        /** Connect a raw client. `path` defaults to `/?sid=<timestamp>` */
        connect(path, wsOptions) {
            const target = path === undefined ? `/?sid=${Date.now()}` : path;
            const client = new TestClient(`ws://127.0.0.1:${port}${target}`, wsOptions);
            clients.push(client);
            return client;
        },

        /** Connect a client and wait until the server reported that it is ready */
        async connectReady(path, wsOptions) {
            const client = this.connect(path, wsOptions);
            await client.opened;
            await client.waitForReady();
            return client;
        },

        async destroy() {
            for (const client of clients) {
                client.terminate();
            }
            socketServer.close();
            webServer.closeAllConnections();
            for (const socket of rawSockets) {
                socket.destroy();
            }
            rawSockets.clear();
            await new Promise(resolve => webServer.close(resolve));
        },
    };
}

module.exports = {
    MESSAGE_TYPES,
    UUID_PATTERN,
    Socket,
    SocketIO,
    TestClient,
    captureConsole,
    createTestServer,
    wait,
};
