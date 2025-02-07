import { type ParsedUrlQuery } from 'node:querystring';
import type { IncomingMessage, Server as HTTPServer } from 'node:http';
import type { Server as HTTPSServer } from 'node:https';
export type SocketEventHandler = (...args: any[]) => void;
export interface SocketACL {
    user: `system.user.${string}` | '';
    groups: `system.group.${string}`[];
    object?: {
        read: boolean;
        list: boolean;
        write: boolean;
        delete: boolean;
    };
    state?: {
        list: boolean;
        read: boolean;
        write: boolean;
        delete: boolean;
        create: boolean;
    };
    users?: {
        create: boolean;
        delete: boolean;
        write: boolean;
    };
    other?: {
        http: boolean;
        execute: boolean;
        sendto: boolean;
    };
    file?: {
        list: boolean;
        create: boolean;
        write: boolean;
        read: boolean;
        delete: boolean;
    };
}
export declare class Socket {
    #private;
    ws: WebSocket;
    id: string;
    _secure: boolean;
    _sessionID: string | undefined;
    _acl: SocketACL | null;
    subscribe: {
        fileChange?: {
            regex: RegExp;
            pattern: string;
        }[];
        stateChange?: {
            regex: RegExp;
            pattern: string;
        }[];
        objectChange?: {
            regex: RegExp;
            pattern: string;
        }[];
        log?: {
            regex: RegExp;
            pattern: string;
        }[];
    } | undefined;
    _authPending: ((isUserAuthenticated: boolean, isAuthenticationUsed: boolean) => void) | undefined;
    _name: string;
    _lastActivity: number | undefined;
    _sessionTimer: NodeJS.Timeout | undefined;
    conn: {
        request: {
            sessionID: string;
            pathname: string;
            query?: ParsedUrlQuery;
        };
    };
    connection: {
        remoteAddress: string;
    };
    /** Query object from URL */
    query: ParsedUrlQuery;
    /**
     *
     * @param ws WebSocket object from ws package
     * @param sessionID session ID
     * @param query query object from URL
     * @param remoteAddress IP address of the client
     * @param pathname path of the request URL for different handlers on one server
     */
    constructor(ws: WebSocket, sessionID: string, query: ParsedUrlQuery, remoteAddress: string, pathname: string);
    /**
     * Do not start ping/pong, do not process any messages and do not send any, as it will be processed by custom handler
     */
    enableCustomHandler(onCloseForced?: () => void): void;
    /**
     * Install handler on event
     */
    on(name: string, cb: SocketEventHandler): void;
    /**
     * Remove handler from event
     */
    off(name: string, cb: SocketEventHandler): void;
    emit(name: string, ...args: any[]): void;
    close(): void;
}
export declare class SocketIO {
    #private;
    /** This attribute is used to detect ioBroker socket */
    ioBroker: boolean;
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
    close(): void;
}
