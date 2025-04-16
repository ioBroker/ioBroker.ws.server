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
    // this variable is used by @iobroker/socket-classes
    _sessionExpiresAt;
    // used by cloud
    _apiKeyOk;
    // used by cloud
    _subSockets;
    // used by cloud
    __apiVersion;
    ___socket; // store the main socket under ___socket
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
     * @param options Options
     * @param options.sessionID session ID
     * @param options.query query object from URL
     * @param options.remoteAddress IP address of the client
     * @param options.pathname path of the request URL for different handlers on one server
     * @param options.cookie cookie string
     * @param options.authorization headers.authorization string
     */
    constructor(ws, options) {
        this.ws = ws;
        this._name = options.query.name;
        this.query = options.query;
        this.connection = { remoteAddress: options.remoteAddress };
        this.id = options.sessionID;
        // simulate interface of socket.io
        this.conn = {
            request: {
                sessionID: options.sessionID,
                pathname: options.pathname,
                query: options.query,
                headers: { cookie: options.cookie, authorization: options.authorization },
            },
            authorization: options.authorization,
        };
        this.#pingInterval = setInterval(() => {
            if (Date.now() - this.#lastPong > 5000) {
                ws.send(JSON.stringify([MESSAGE_TYPES.PING]));
            }
            if (Date.now() - this.#lastPong > 15000) {
                this.close();
            }
        }, 5000);
        ws.onmessage = (event) => {
            if (this.#customHandler) {
                // do not process any messages
                return;
            }
            this.#lastPong = Date.now();
            if (!event?.data || typeof event.data !== 'string') {
                console.error(`Received invalid event: ${JSON.stringify(event?.data)}`);
                return;
            }
            let messageArray;
            try {
                messageArray = JSON.parse(event.data);
            }
            catch {
                console.error(`Received invalid event: ${JSON.stringify(event)}`);
                return;
            }
            const type = messageArray[0];
            const id = messageArray[1];
            const name = messageArray[2];
            const args = messageArray[3];
            if (type === MESSAGE_TYPES.CALLBACK) {
                if (DEBUG) {
                    console.log(name);
                }
                if (this.#handlers[name]) {
                    this.#withCallback(name, false, id, ...args);
                }
                if (this.#handlers['*']) {
                    this.#withCallback(name, true, id, ...args);
                }
            }
            else if (type === MESSAGE_TYPES.MESSAGE) {
                if (DEBUG) {
                    console.log(name);
                }
                if (this.#handlers[name]) {
                    if (args) {
                        setImmediate(() => this.#handlers[name].forEach(cb => cb.apply(this, args)));
                    }
                    else {
                        setImmediate(() => this.#handlers[name].forEach(cb => cb.call(this)));
                    }
                }
                // If the handler for all message exists, call it
                if (this.#handlers['*']) {
                    if (args) {
                        args.unshift(name);
                        setImmediate(() => this.#handlers['*'].forEach(cb => cb.apply(this, args)));
                    }
                    else {
                        setImmediate(() => this.#handlers['*'].forEach(cb => cb.call(this, name)));
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
                console.log(`Received unknown event type: ${type}`);
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
            this.#handlers[name] ||= [];
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
        if (name && this.#handlers[name] && cb) {
            const pos = this.#handlers[name].indexOf(cb);
            if (pos !== -1) {
                this.#handlers[name].splice(pos, 1);
                if (!this.#handlers[name].length) {
                    delete this.#handlers[name];
                }
            }
        }
        else if (name && this.#handlers[name]) {
            delete this.#handlers[name];
        }
        else if (!name) {
            Object.keys(this.#handlers).forEach(name => {
                delete this.#handlers[name];
            });
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
    #withCallback(name, wildcards, id, ...args) {
        if (!args?.length) {
            setImmediate(() => {
                if (wildcards) {
                    this.#handlers['*'].forEach(cb => cb.call(this, name, (...responseArgs) => this.#responseWithCallback(name, id, ...responseArgs)));
                }
                else {
                    this.#handlers[name].forEach(cb => cb.call(this, (...responseArgs) => this.#responseWithCallback(name, id, ...responseArgs)));
                }
            });
        }
        else {
            setImmediate(() => {
                if (wildcards) {
                    args.unshift(name);
                    this.#handlers['*'].forEach(cb => cb.apply(this, [
                        ...args,
                        (...responseArgs) => this.#responseWithCallback(name, id, ...responseArgs),
                    ]));
                }
                else {
                    this.#handlers[name].forEach(cb => cb.apply(this, [
                        ...args,
                        (...responseArgs) => this.#responseWithCallback(name, id, ...responseArgs),
                    ]));
                }
            });
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
    // Indirectly used in cloud
    disconnect() {
        this.close();
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
                if (query && query.sid) {
                    const socket = new Socket(ws, {
                        // @ts-expect-error sessionID could exists
                        sessionID: request.sessionID || query.sid || '',
                        query,
                        remoteAddress: request.socket.remoteAddress || '',
                        pathname: (request.url || '').split('?')[0],
                        cookie: request.headers.cookie,
                        authorization: request.headers.authorization || request.headers.Authorization,
                    });
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
