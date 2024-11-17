import { parse, type ParsedUrlQuery } from 'node:querystring';
import { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Server as HTTPServer } from 'node:http';
import type { Server as HTTPSServer } from 'node:https';

/** Maximum message size which server accepts */
const MAX_PAYLOAD = 524_288_000;

const MESSAGE_TYPES: Record<string, number> = {
    MESSAGE: 0,
    PING: 1,
    PONG: 2,
    CALLBACK: 3,
};

const DEBUG = false;

export type SocketEventHandler = (...args: any[]) => void;

class Socket {
    public ws: WebSocket;
    public id: string; // session ID
    // this variable is used by @iobroker/socket-classes to store the auth flag
    public _secure: boolean = false;
    // this variable is used by @iobroker/socket-classes to store the sessionID by authentication
    public _sessionID: string | undefined;
    // this variable is used by @iobroker/socket-classes
    public _acl: Record<string, any> = null;

    private messageId: number = 0;
    public _name: string;
    public conn: { request: { sessionID: string } };
    private pingInterval: NodeJS.Timeout | null;
    private readonly handlers: Record<string, SocketEventHandler[]>;
    private lastPong: number = Date.now();
    public connection: { remoteAddress: string };

    public query: ParsedUrlQuery;

    constructor(ws: WebSocket, sessionID: string, query: ParsedUrlQuery, remoteAddress: string) {
        this.ws = ws;
        this._name = query.name as string;
        this.query = query;
        this.connection = { remoteAddress };
        this.handlers = {};
        this.id = sessionID;

        // simulate interface of socket.io
        this.conn = {
            request: { sessionID },
        };

        this.pingInterval = setInterval(() => {
            if (Date.now() - this.lastPong > 5000) {
                ws.send(JSON.stringify([MESSAGE_TYPES.PING]));
            }
            if (Date.now() - this.lastPong > 15000) {
                this.close();
            }
        }, 5000);

        ws.onmessage = (message: MessageEvent<string>): void => {
            this.lastPong = Date.now();

            if (!message?.data || typeof message.data !== 'string') {
                console.error(`Received invalid message: ${JSON.stringify(message?.data)}`);
                return;
            }
            let messageArray: any[];
            try {
                messageArray = JSON.parse(message.data);
            } catch {
                console.error(`Received invalid message: ${JSON.stringify(message)}`);
                return;
            }

            const type: number = messageArray[0];
            const id: number = messageArray[1];
            const name: string = messageArray[2];
            const args: any[] = messageArray[3];

            if (type === MESSAGE_TYPES.CALLBACK) {
                DEBUG && console.log(name);
                this.handlers[name] && this.withCallback(name, id, ...args);
            } else if (type === MESSAGE_TYPES.MESSAGE) {
                DEBUG && console.log(name);
                if (this.handlers[name]) {
                    if (args) {
                        setImmediate(() => this.handlers[name]?.forEach(cb => cb.apply(this, args)));
                    } else {
                        setImmediate(() => this.handlers[name]?.forEach(cb => cb.call(this)));
                    }
                }
            } else if (type === MESSAGE_TYPES.PING) {
                ws.send(JSON.stringify([MESSAGE_TYPES.PONG]));
            } else if (type === MESSAGE_TYPES.PONG) {
                // lastPong saved
            } else {
                console.log(`Received unknown message type: ${type}`);
            }
        };
    }

    on(name: string, cb: SocketEventHandler): void {
        if (cb) {
            this.handlers[name] = this.handlers[name] || [];
            this.handlers[name].push(cb);
        }
    }

    off(name: string, cb: SocketEventHandler): void {
        if (this.handlers[name]) {
            const pos = this.handlers[name].indexOf(cb);
            if (pos !== -1) {
                this.handlers[name].splice(pos, 1);
                if (!this.handlers[name].length) {
                    delete this.handlers[name];
                }
            }
        }
    }

    emit(name: string, ...args: any[]): void {
        this.messageId++;
        if (this.messageId >= 0xffffffff) {
            this.messageId = 1;
        }
        if (!args?.length) {
            this.ws.send(JSON.stringify([MESSAGE_TYPES.MESSAGE, this.messageId, name]));
        } else {
            this.ws.send(JSON.stringify([MESSAGE_TYPES.MESSAGE, this.messageId, name, args]));
        }
    }

    responseWithCallback(name: string, id: number, ...args: any[]): void {
        // error cannot be converted normally, so try to use internal function for it
        if (args && args[0] instanceof Error) {
            args[0] = args[0].toString();
        }

        if (!args?.length) {
            return this.ws.send(JSON.stringify([MESSAGE_TYPES.CALLBACK, id, name]));
        }

        this.ws.send(JSON.stringify([MESSAGE_TYPES.CALLBACK, id, name, args]));
    }

    withCallback(name: string, id: number, ...args: any[]): void {
        if (!args?.length) {
            setImmediate(() =>
                this.handlers[name]?.forEach(cb =>
                    cb.call(this, (...responseArgs: any[]) => this.responseWithCallback(name, id, ...responseArgs)),
                ),
            );
        } else {
            setImmediate(() =>
                this.handlers[name]?.forEach(cb =>
                    cb.apply(this, [
                        ...args,
                        (...responseArgs: any[]) => this.responseWithCallback(name, id, ...responseArgs),
                    ]),
                ),
            );
        }
    }

    close(): void {
        this.pingInterval && clearInterval(this.pingInterval);
        this.pingInterval = null;

        this.handlers.disconnect?.forEach(cb => cb.apply(this));

        Object.keys(this.handlers).forEach(name => (this.handlers[name] = undefined));

        try {
            this.ws.close();
        } catch {
            // ignore
        }
    }
}

type IncomingMessageEx = IncomingMessage & { _wsNotAuth?: boolean };

export class SocketIO {
    public ioBroker = true;
    private handlers: { [event: string]: SocketEventHandler[] };
    private socketsList: Socket[] = [];
    private run: ((req: IncomingMessage, cb: (err: boolean) => void) => void)[] = [];
    public engine: {
        clientsCount: number;
    };

    public sockets: {
        connected: Socket[]; // for socket.io 2.0 compatibility
        sockets: Socket[]; // for socket.io 4.0 compatibility
        emit: (name: string, ...args: any[]) => void;
        engine: {
            clientsCount: number;
        };
    };

    constructor(server: HTTPServer | HTTPSServer) {
        const wss = new WebSocketServer({
            server,
            verifyClient: (info, done) => {
                if (this.run.length) {
                    this.run.forEach(cb =>
                        cb(info.req, err => {
                            if (err) {
                                (info.req as IncomingMessageEx)._wsNotAuth = true;
                            }
                            done && done(true);
                            done = null;
                        }),
                    );
                } else {
                    done && done(true);
                    done = null;
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

        wss.on('connection', (ws: WebSocket, request: IncomingMessageEx) => {
            DEBUG && console.log('connected');

            if (!request) {
                console.error('Unexpected behaviour: request is NULL!');
            }

            if (request?._wsNotAuth) {
                const ip: string = (request.headers['x-forwarded-for'] as string) || request.socket.remoteAddress;

                this.handlers.error?.forEach(cb => cb('error', `authentication failed for ${ip}`));
                ws.send(JSON.stringify([MESSAGE_TYPES.MESSAGE, 401, 'reauthenticate']));
                setTimeout(() => ws?.close(), 500);
            } else {
                let query;

                try {
                    if (request) {
                        const queryString = request.url.split('?')[1];
                        query = parse(queryString || '');
                    }
                } catch {
                    query = null;
                }

                // do not write here query?.sid otherwise typescript thinks, that query could be null below
                if (query && query.sid) {
                    const socket = new Socket(
                        ws,
                        // @ts-expect-error pass the sessionID of HTTP request to socket
                        request.sessionID || query.sid,
                        query,
                        request.socket.remoteAddress,
                    );
                    this.socketsList.push(socket);
                    this.sockets.engine.clientsCount = this.socketsList.length;

                    ws.onclose = () => {
                        DEBUG && console.log('closed');
                        let i;
                        for (i = 0; i < this.socketsList.length; i++) {
                            if (this.socketsList[i].ws === ws) {
                                this.socketsList[i].close();
                                this.socketsList.splice(i, 1);
                                this.sockets.engine.clientsCount = this.socketsList.length;
                                return;
                            }
                        }
                    };

                    ws.onerror = error => {
                        if (this.handlers.error) {
                            this.handlers.error.forEach(cb => cb('error', error));
                        } else {
                            console.error(`Web socket error: ${JSON.stringify(error)}`);
                        }
                        ws?.close();
                    };

                    // install handlers
                    if (this.handlers.connection?.length) {
                        // we have a race condition here.
                        // If the user is not admin, it will be requested for him the rights and no handlers will be installed.
                        // So we must be sure that all event handlers are installed before sending ___ready___.
                        let timeout = setTimeout(() => {
                            timeout = null;
                            socket.emit('___ready___');
                            console.warn('Sent ready, but not all handlers installed!');
                        }, 1500); // TODO, This parameter must be configurable

                        this.handlers.connection.forEach(cb =>
                            cb(socket, () => {
                                if (timeout) {
                                    clearTimeout(timeout);
                                    timeout = null;
                                    // say to a client we are ready
                                    socket.emit('___ready___');
                                }
                            }),
                        );
                    } else {
                        socket.emit('___ready___');
                    }
                } else {
                    if (request) {
                        const ip: string =
                            (request.headers['x-forwarded-for'] as string) || request.socket.remoteAddress;

                        this.handlers.error?.forEach(cb => cb('error', `No sid found from ${ip}`));
                    } else {
                        this.handlers.error?.forEach(cb => cb('error', 'No sid found'));
                    }

                    ws.send(JSON.stringify([MESSAGE_TYPES.MESSAGE, 501, 'error', ['invalid sid']]));

                    setTimeout(() => ws?.close(), 500);
                }
            }
        });

        wss.on('error', (error: Error): void => {
            if (this.handlers.error) {
                this.handlers.error.forEach(cb => cb('error', error));
            } else {
                console.error(`Web socket server error: ${error}`);
            }
        });

        this.sockets = {
            connected: this.socketsList, // for socket.io 2.0 compatibility
            sockets: this.socketsList, // for socket.io 4.0 compatibility
            emit: (name: string, ...args: any[]): void =>
                this.socketsList.forEach(socket => socket.emit(name, ...args)),
            engine: {
                clientsCount: 0,
            },
        };

        this.engine = this.sockets.engine;
    }

    on(name: string, cb: SocketEventHandler): void {
        if (cb) {
            this.handlers = this.handlers || {};
            this.handlers[name] = this.handlers[name] || [];
            this.handlers[name].push(cb);
        }
    }

    off(name: string, cb: SocketEventHandler): void {
        if (this.handlers && this.handlers[name]) {
            const pos = this.handlers[name].indexOf(cb);
            if (pos !== -1) {
                this.handlers[name].splice(pos, 1);
                if (!this.handlers[name].length) {
                    delete this.handlers[name];
                }
            }
        }
    }

    use(cb: (req: IncomingMessage, cb: (err: boolean) => void) => void): SocketIO {
        this.run.push(cb);
        return this;
    }
}
