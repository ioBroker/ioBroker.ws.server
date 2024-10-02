import { type ParsedUrlQuery } from 'node:querystring';
import type { IncomingMessage } from 'node:http';
import type { Server as HTTPServer } from 'node:http';
import type { Server as HTTPSServer } from 'node:https';
export type SocketEventHandler = (...args: any[]) => void;
declare class Socket {
    ws: WebSocket;
    private id;
    private _name;
    private conn;
    private pingInterval;
    private readonly handlers;
    private lastPong;
    connection: {
        remoteAddress: string;
    };
    query: ParsedUrlQuery | null;
    constructor(ws: WebSocket, options: {
        remoteAddress: string;
        query?: ParsedUrlQuery;
    });
    on(name: string, cb: SocketEventHandler): void;
    off(name: string, cb: SocketEventHandler): void;
    emit(name: string, ...args: any[]): void;
    responseWithCallback(name: string, id: number, ...args: any[]): void;
    withCallback(name: string, id: number, ...args: any[]): void;
    close(): void;
}
export declare class SocketIO {
    ioBroker: boolean;
    private handlers;
    private socketsList;
    private run;
    engine: {
        clientsCount: number;
    };
    sockets: {
        connected: Socket[];
        sockets: Socket[];
        emit: (name: string, ...args: any[]) => void;
        engine: {
            clientsCount: number;
        };
    };
    constructor(server: HTTPServer | HTTPSServer);
    on(name: string, cb: SocketEventHandler): void;
    off(name: string, cb: SocketEventHandler): void;
    use(cb: (req: IncomingMessage, cb: (err: boolean) => void) => void): SocketIO;
}
export {};
