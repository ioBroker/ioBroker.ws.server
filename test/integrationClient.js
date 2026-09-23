'use strict';

const assert = require('node:assert');
const WebSocket = require('ws');

const { createTestServer, wait } = require('./lib/helpers');

// The package registers itself as `globalThis.io`, exactly like in the browser
require('@iobroker/ws');

/**
 * Integration tests against the real counterpart `@iobroker/ws`.
 *
 * The client is a browser library, but it accepts the WebSocket implementation
 * as an option, so it can be driven in Node.js with the `ws` package.
 */
describe('Integration with @iobroker/ws', function () {
    this.timeout(20000);

    let server;
    /** All clients of the running test */
    let clients;

    beforeEach(() => {
        clients = [];
    });

    afterEach(async () => {
        for (const client of clients) {
            client.destroy();
        }
        clients = [];
        if (server) {
            await server.destroy();
            server = null;
        }
    });

    /** Create a client, but do not wait for the connection */
    function createClient(options = {}) {
        const client = globalThis.io.connect(`http://127.0.0.1:${server.port}`, { WebSocket, ...options });
        clients.push(client);
        return client;
    }

    /** Create a client and wait until it is connected */
    function connectClient(options = {}) {
        return new Promise((resolve, reject) => {
            const client = createClient(options);
            const timer = setTimeout(() => reject(new Error('The client did not connect')), 10000);
            client.on('connect', () => {
                clearTimeout(timer);
                resolve(client);
            });
        });
    }

    /** Wait for the message `name` of the client and return its arguments */
    function waitForMessage(client, name, timeout = 5000) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Timeout while waiting for "${name}"`)), timeout);
            client.on(name, (...args) => {
                clearTimeout(timer);
                resolve(args);
            });
        });
    }

    describe('Connection', () => {
        it('connects and reports "connect"', async () => {
            server = await createTestServer();

            const client = await connectClient();
            assert.strictEqual(client.connected, true);
            assert.strictEqual(server.sockets.length, 1);
        });

        it('sends its own sid, but the server generates the socket id', async () => {
            server = await createTestServer();
            const client = await connectClient();

            assert.ok(server.socket.query.sid, 'The client must send a sid');
            assert.strictEqual(String(server.socket.query.sid), String(client.sessionID));
            assert.notStrictEqual(server.socket.id, String(client.sessionID));
        });

        it('transports the option "name" in the query', async () => {
            server = await createTestServer();
            await connectClient({ name: 'admin.0' });

            assert.strictEqual(server.socket._name, 'admin.0');
        });

        it('transports the option "token" in the query', async () => {
            server = await createTestServer();
            await connectClient({ token: 'my-token' });

            assert.strictEqual(server.socket.query.token, 'my-token');
        });

        it('reports "disconnect" if the server closes the socket', async () => {
            server = await createTestServer();
            const client = await connectClient();

            const disconnected = new Promise(resolve => client.on('disconnect', resolve));
            server.socket.close();
            await disconnected;

            assert.strictEqual(client.connected, false);
        });

        it('reconnects automatically and reports "reconnect"', async () => {
            server = await createTestServer();
            const client = await connectClient();
            const firstSocketId = server.socket.id;

            const reconnected = new Promise(resolve => client.on('reconnect', resolve));
            server.socket.close();
            await reconnected;

            assert.strictEqual(client.connected, true);
            assert.strictEqual(server.sockets.length, 2);
            assert.notStrictEqual(server.socket.id, firstSocketId);
        });

        it('receives "reauthenticate" if a middleware rejects it', async () => {
            server = await createTestServer({ use: [(_req, next) => next(true)] });

            const client = createClient();
            assert.deepStrictEqual(await waitForMessage(client, 'reauthenticate', 8000), []);
        });
    });

    describe('Client to server', () => {
        it('transports an emit without a callback', async () => {
            const received = [];
            server = await createTestServer({
                onConnection: (socket, initDone) => {
                    socket.on('notify', (...args) => received.push(args));
                    initDone();
                },
            });

            const client = await connectClient();
            client.emit('notify', 'hello', 42);
            await wait(200);

            assert.deepStrictEqual(received, [['hello', 42]]);
        });

        it('transports an emit without any argument', async () => {
            const received = [];
            server = await createTestServer({
                onConnection: (socket, initDone) => {
                    socket.on('notify', (...args) => received.push(args));
                    initDone();
                },
            });

            const client = await connectClient();
            client.emit('notify');
            await wait(200);

            assert.deepStrictEqual(received, [[]]);
        });

        it('gets the answer of a callback', async () => {
            server = await createTestServer({
                onConnection: (socket, initDone) => {
                    socket.on('add', (value, cb) => cb(null, value + 1));
                    initDone();
                },
            });

            const client = await connectClient();
            const answer = await new Promise(resolve => client.emit('add', 41, (...args) => resolve(args)));

            assert.deepStrictEqual(answer, [null, 42]);
        });

        it('gets an error of the server as a string', async () => {
            server = await createTestServer({
                onConnection: (socket, initDone) => {
                    socket.on('fail', cb => cb(new Error('not allowed')));
                    initDone();
                },
            });

            const client = await connectClient();
            const answer = await new Promise(resolve => client.emit('fail', (...args) => resolve(args)));

            assert.deepStrictEqual(answer, ['Error: not allowed']);
        });

        it('answers parallel requests with the matching callbacks', async () => {
            server = await createTestServer({
                onConnection: (socket, initDone) => {
                    socket.on('delay', (ms, value, cb) => setTimeout(() => cb(null, value), ms));
                    initDone();
                },
            });

            const client = await connectClient();
            const request = (ms, value) =>
                new Promise(resolve => client.emit('delay', ms, value, (_err, result) => resolve(result)));

            assert.deepStrictEqual(await Promise.all([request(150, 'a'), request(10, 'b'), request(70, 'c')]), [
                'a',
                'b',
                'c',
            ]);
        });

        it('sends messages that were emitted before the connection was established', async () => {
            const received = [];
            server = await createTestServer({
                onConnection: (socket, initDone) => {
                    socket.on('early', value => received.push(value));
                    initDone();
                },
            });

            const client = createClient();
            // The client is not connected yet, the messages have to be buffered
            client.emit('early', 1);
            client.emit('early', 2);

            await new Promise(resolve => client.on('connect', resolve));
            await wait(300);

            assert.deepStrictEqual(received, [1, 2]);
        });

        it('transports a payload of one megabyte', async () => {
            const payload = 'y'.repeat(1024 * 1024);
            server = await createTestServer({
                onConnection: (socket, initDone) => {
                    socket.on('echo', (data, cb) => cb(null, data));
                    initDone();
                },
            });

            const client = await connectClient();
            const answer = await new Promise(resolve => client.emit('echo', payload, (_err, data) => resolve(data)));

            assert.strictEqual(answer, payload);
        });
    });

    describe('Server to client', () => {
        it('transports an emit of the server with arguments', async () => {
            server = await createTestServer();
            const client = await connectClient();

            const promise = waitForMessage(client, 'stateChange');
            server.socket.emit('stateChange', 'javascript.0.test', { val: 1, ack: true });

            assert.deepStrictEqual(await promise, ['javascript.0.test', { val: 1, ack: true }]);
        });

        it('transports an emit of the server without arguments', async () => {
            server = await createTestServer();
            const client = await connectClient();

            const promise = waitForMessage(client, 'ping');
            server.socket.emit('ping');

            assert.deepStrictEqual(await promise, []);
        });

        it('reaches all clients via sockets.emit()', async () => {
            server = await createTestServer();
            const first = await connectClient();
            const second = await connectClient();

            const promises = [waitForMessage(first, 'broadcast'), waitForMessage(second, 'broadcast')];
            server.socketServer.sockets.emit('broadcast', 'for everybody');

            assert.deepStrictEqual(await Promise.all(promises), [['for everybody'], ['for everybody']]);
        });

        it('removes a handler again with off()', async () => {
            server = await createTestServer();
            const client = await connectClient();

            const calls = [];
            const handler = value => calls.push(value);
            client.on('event', handler);
            client.off('event', handler);

            server.socket.emit('event', 'ignored');
            await wait(300);

            assert.deepStrictEqual(calls, []);
        });

        it('calls all handlers of an event', async () => {
            server = await createTestServer();
            const client = await connectClient();

            const calls = [];
            client.on('event', value => calls.push(`first:${value}`));
            client.on('event', value => calls.push(`second:${value}`));

            server.socket.emit('event', 'x');
            await wait(300);

            assert.deepStrictEqual(calls, ['first:x', 'second:x']);
        });
    });

    describe('Wildcard handler on the server', () => {
        it('receives every event of the client with its name', async () => {
            const received = [];
            server = await createTestServer({
                onConnection: (socket, initDone) => {
                    socket.on('*', (...args) => received.push(args));
                    initDone();
                },
            });

            const client = await connectClient();
            client.emit('first', 1);
            client.emit('second', 'a', 'b');
            await wait(300);

            assert.deepStrictEqual(received, [
                ['first', 1],
                ['second', 'a', 'b'],
            ]);
        });

        it('can answer a callback of the client', async () => {
            server = await createTestServer({
                onConnection: (socket, initDone) => {
                    socket.on('*', (name, ...rest) => {
                        const cb = rest.pop();
                        cb(null, `${name}:${rest.join(',')}`);
                    });
                    initDone();
                },
            });

            const client = await connectClient();
            const answer = await new Promise(resolve =>
                client.emit('getValue', 'a', 'b', (_err, value) => resolve(value)),
            );

            assert.strictEqual(answer, 'getValue:a,b');
        });
    });
});
