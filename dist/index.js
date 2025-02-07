"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SocketIO = exports.Socket = void 0;
const node_querystring_1 = require("node:querystring");
const ws_1 = require("ws");
/** Maximum message size which server accepts */
const MAX_PAYLOAD = 524_288_000;
const MESSAGE_TYPES = {
    MESSAGE: 0,
    PING: 1,
    PONG: 2,
    CALLBACK: 3,
};
const DEBUG = false;
class Socket {
    ws;
    id; // session ID
    // this variable is used by @iobroker/socket-classes to store the auth flag
    _secure = false;
    // this variable is used by @iobroker/socket-classes to store the sessionID by authentication
    _sessionID;
    // this variable is used by @iobroker/socket-classes to store ACL
    _acl = null;
    // this variable is used by @iobroker/socket-classes to store subscribe settings
    subscribe = undefined;
    // this variable is used by @iobroker/socket-classes to store authentication pending
    _authPending;
    // this variable is used by @iobroker/socket-classes
    _name;
    // this variable is used by @iobroker/socket-classes
    _lastActivity;
    // this variable is used by @iobroker/socket-classes
    _sessionTimer;
    conn;
    connection;
    /** Query object from URL */
    query;
    #handlers = {};
    #messageId = 0;
    #pingInterval;
    #lastPong = Date.now();
    #customHandler = false;
    /**
     *
     * @param ws WebSocket object from ws package
     * @param sessionID session ID
     * @param query query object from URL
     * @param remoteAddress IP address of the client
     * @param pathname path of the request URL for different handlers on one server
     */
    constructor(ws, sessionID, query, remoteAddress, pathname) {
        this.ws = ws;
        this._name = query.name;
        this.query = query;
        this.connection = { remoteAddress };
        this.id = sessionID;
        // simulate interface of socket.io
        this.conn = {
            request: { sessionID, pathname, query },
        };
        this.#pingInterval = setInterval(() => {
            if (Date.now() - this.#lastPong > 5000) {
                ws.send(JSON.stringify([MESSAGE_TYPES.PING]));
            }
            if (Date.now() - this.#lastPong > 15000) {
                this.close();
            }
        }, 5000);
        ws.onmessage = (message) => {
            this.#lastPong = Date.now();
            if (!message?.data || typeof message.data !== 'string') {
                console.error(`Received invalid message: ${JSON.stringify(message?.data)}`);
                return;
            }
            let messageArray;
            try {
                messageArray = JSON.parse(message.data);
            }
            catch {
                console.error(`Received invalid message: ${JSON.stringify(message)}`);
                return;
            }
            const type = messageArray[0];
            const id = messageArray[1];
            const name = messageArray[2];
            const args = messageArray[3];
            if (type === MESSAGE_TYPES.CALLBACK) {
                DEBUG && console.log(name);
                this.#handlers[name] && this.#withCallback(name, id, ...args);
            }
            else if (type === MESSAGE_TYPES.MESSAGE) {
                DEBUG && console.log(name);
                if (this.#handlers[name]) {
                    if (args) {
                        setImmediate(() => this.#handlers[name]?.forEach(cb => cb.apply(this, args)));
                    }
                    else {
                        setImmediate(() => this.#handlers[name]?.forEach(cb => cb.call(this)));
                    }
                }
            }
            else if (type === MESSAGE_TYPES.PING) {
                ws.send(JSON.stringify([MESSAGE_TYPES.PONG]));
            }
            else if (type === MESSAGE_TYPES.PONG) {
                // lastPong saved
            }
            else {
                console.log(`Received unknown message type: ${type}`);
            }
        };
    }
    /**
     * Do not start ping/pong, do not process any messages and do not send any, as it will be processed by custom handler
     */
    enableCustomHandler(onCloseForced) {
        if (!this.#customHandler) {
            if (this.#pingInterval) {
                clearInterval(this.#pingInterval);
                this.#pingInterval = null;
            }
            this.#customHandler = true;
            const names = Object.keys(this.#handlers);
            for (const name of names) {
                delete this.#handlers[name];
            }
            if (onCloseForced) {
                // Inform custom handler, that ws socket was closed
                this.#handlers.disconnect = [onCloseForced];
            }
        }
    }
    /**
     * Install handler on event
     */
    on(name, cb) {
        if (this.#customHandler) {
            throw new Error('Cannot use on() with custom handler');
        }
        if (cb) {
            this.#handlers[name] = this.#handlers[name] || [];
            this.#handlers[name].push(cb);
        }
    }
    /**
     * Remove handler from event
     */
    off(name, cb) {
        if (this.#customHandler) {
            throw new Error('Cannot use off() with custom handler');
        }
        if (this.#handlers[name]) {
            const pos = this.#handlers[name].indexOf(cb);
            if (pos !== -1) {
                this.#handlers[name].splice(pos, 1);
                if (!this.#handlers[name].length) {
                    delete this.#handlers[name];
                }
            }
        }
    }
    emit(name, ...args) {
        if (this.#customHandler) {
            throw new Error('Cannot use emit() with custom handler');
        }
        this.#messageId++;
        if (this.#messageId >= 0xffffffff) {
            this.#messageId = 1;
        }
        if (!args?.length) {
            this.ws.send(JSON.stringify([MESSAGE_TYPES.MESSAGE, this.#messageId, name]));
        }
        else {
            this.ws.send(JSON.stringify([MESSAGE_TYPES.MESSAGE, this.#messageId, name, args]));
        }
    }
    #responseWithCallback(name, id, ...args) {
        // error cannot be converted normally, so try to use internal function for it
        if (args && args[0] instanceof Error) {
            args[0] = args[0].toString();
        }
        if (!args?.length) {
            return this.ws.send(JSON.stringify([MESSAGE_TYPES.CALLBACK, id, name]));
        }
        this.ws.send(JSON.stringify([MESSAGE_TYPES.CALLBACK, id, name, args]));
    }
    #withCallback(name, id, ...args) {
        if (!args?.length) {
            setImmediate(() => this.#handlers[name]?.forEach(cb => cb.call(this, (...responseArgs) => this.#responseWithCallback(name, id, ...responseArgs))));
        }
        else {
            setImmediate(() => this.#handlers[name]?.forEach(cb => cb.apply(this, [
                ...args,
                (...responseArgs) => this.#responseWithCallback(name, id, ...responseArgs),
            ])));
        }
    }
    close() {
        if (this.#pingInterval) {
            clearInterval(this.#pingInterval);
            this.#pingInterval = null;
        }
        this.#handlers.disconnect?.forEach(cb => cb.apply(this));
        // delete all handlers
        Object.keys(this.#handlers).forEach(name => (this.#handlers[name] = undefined));
        try {
            this.ws.close();
        }
        catch {
            // ignore
        }
    }
}
exports.Socket = Socket;
class SocketIO {
    /** This attribute is used to detect ioBroker socket */
    ioBroker = true;
    engine;
    #handlers = {};
    #socketsList = [];
    #run = [];
    sockets;
    constructor(server) {
        const wss = new ws_1.WebSocketServer({
            server,
            verifyClient: (info, done) => {
                let finished = false;
                if (this.#run.length) {
                    this.#run.forEach(cb => cb(info.req, err => {
                        if (err) {
                            info.req._wsNotAuth = true;
                        }
                        if (done && !finished) {
                            finished = true;
                            done(true);
                        }
                    }));
                }
                else if (done && !finished) {
                    finished = true;
                    done(true);
                }
            },
            perMessageDeflate: {
                zlibDeflateOptions: {
                    chunkSize: 1024,
                    memLevel: 9,
                    level: 9,
                },
                zlibInflateOptions: {
                    chunkSize: 16 * 1024,
                },
                clientNoContextTakeover: true,
                serverNoContextTakeover: true,
            },
            maxPayload: MAX_PAYLOAD,
        });
        wss.on('connection', (ws, request) => {
            if (DEBUG) {
                console.log('connected');
            }
            if (!request) {
                console.error('Unexpected behaviour: request is NULL!');
            }
            if (request?._wsNotAuth) {
                const ip = request.headers['x-forwarded-for'] || request.socket.remoteAddress;
                this.#handlers.error?.forEach(cb => cb('error', `authentication failed for ${ip}`));
                ws.send(JSON.stringify([MESSAGE_TYPES.MESSAGE, 401, 'reauthenticate']));
                setTimeout(() => ws?.close(), 500);
            }
            else {
                let query;
                try {
                    if (request) {
                        const queryString = (request.url || '').split('?')[1];
                        query = (0, node_querystring_1.parse)(queryString || '');
                    }
                }
                catch {
                    query = null;
                }
                if (query?.sid) {
                    const socket = new Socket(ws, 
                    // @ts-expect-error sessionID could exists
                    request.sessionID || query.sid || '', query, request.socket.remoteAddress || '', (request?.url || '').split('?')[0]);
                    this.#socketsList.push(socket);
                    this.sockets.engine.clientsCount = this.#socketsList.length;
                    ws.onclose = () => {
                        if (DEBUG) {
                            console.log('closed');
                        }
                        let i;
                        for (i = 0; i < this.#socketsList.length; i++) {
                            if (this.#socketsList[i].ws === ws) {
                                this.#socketsList[i].close();
                                this.#socketsList.splice(i, 1);
                                this.sockets.engine.clientsCount = this.#socketsList.length;
                                return;
                            }
                        }
                    };
                    ws.onerror = error => {
                        if (this.#handlers.error) {
                            this.#handlers.error.forEach(cb => cb('error', error));
                        }
                        else {
                            console.error(`Web socket error: ${JSON.stringify(error)}`);
                        }
                        ws?.close();
                    };
                    // install handlers
                    if (this.#handlers.connection?.length) {
                        // we have a race condition here.
                        // If the user is not admin, it will be requested for him the rights and no handlers will be installed.
                        // So we must be sure that all event handlers are installed before sending ___ready___.
                        let timeout = setTimeout(() => {
                            timeout = null;
                            socket.emit('___ready___');
                            console.warn('Sent ready, but not all handlers installed!');
                        }, 1500); // TODO, This parameter must be configurable
                        this.#handlers.connection.forEach((cb) => cb(socket, (customHandler) => {
                            if (timeout) {
                                clearTimeout(timeout);
                                timeout = null;
                                // If not custom handler, send ready
                                if (!customHandler) {
                                    // say to a client we are ready
                                    socket.emit('___ready___');
                                }
                            }
                        }));
                    }
                    else {
                        socket.emit('___ready___');
                    }
                }
                else {
                    if (request) {
                        const ip = request.headers['x-forwarded-for'] || request.socket.remoteAddress;
                        this.#handlers.error?.forEach(cb => cb('error', `No sid found from ${ip}`));
                    }
                    else {
                        this.#handlers.error?.forEach(cb => cb('error', 'No sid found'));
                    }
                    ws.send(JSON.stringify([MESSAGE_TYPES.MESSAGE, 501, 'error', ['invalid sid']]));
                    setTimeout(() => ws?.close(), 500);
                }
            }
        });
        wss.on('error', (error) => {
            if (this.#handlers.error) {
                this.#handlers.error.forEach(cb => cb('error', error));
            }
            else {
                console.error(`Web socket server error: ${error}`);
            }
        });
        this.sockets = {
            connected: this.#socketsList, // for socket.io 2.0 compatibility
            sockets: this.#socketsList, // for socket.io 4.0 compatibility
            emit: (name, ...args) => this.#socketsList.forEach(socket => socket.emit(name, ...args)),
            engine: {
                clientsCount: 0,
            },
        };
        this.engine = this.sockets.engine;
    }
    on(name, cb) {
        if (cb) {
            this.#handlers = this.#handlers || {};
            this.#handlers[name] = this.#handlers[name] || [];
            this.#handlers[name].push(cb);
        }
    }
    off(name, cb) {
        if (this.#handlers && this.#handlers[name]) {
            const pos = this.#handlers[name].indexOf(cb);
            if (pos !== -1) {
                this.#handlers[name].splice(pos, 1);
                if (!this.#handlers[name].length) {
                    delete this.#handlers[name];
                }
            }
        }
    }
    use(cb) {
        this.#run.push(cb);
        return this;
    }
    close() {
        this.#socketsList.forEach(socket => socket.close());
    }
}
exports.SocketIO = SocketIO;
