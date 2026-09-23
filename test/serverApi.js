'use strict';

const assert = require('node:assert');

const { MESSAGE_TYPES, createTestServer, wait } = require('./lib/helpers');

describe('SocketIO server API', function () {
    this.timeout(15000);

    let server;

    afterEach(async () => {
        if (server) {
            await server.destroy();
            server = null;
        }
    });

    describe('Compatibility interface', () => {
        it('marks itself as an ioBroker socket', async () => {
            server = await createTestServer();
            assert.strictEqual(server.socketServer.ioBroker, true);
        });

        it('offers the socket list as "connected" (socket.io 2.0) and "sockets" (socket.io 4.0)', async () => {
            server = await createTestServer();
            await server.connectReady();

            assert.strictEqual(server.socketServer.sockets.connected, server.socketServer.sockets.sockets);
            assert.strictEqual(server.socketServer.sockets.sockets.length, 1);
            assert.strictEqual(server.socketServer.sockets.sockets[0], server.socket);
        });

        it('offers engine and sockets.engine as the same object', async () => {
            server = await createTestServer();
            assert.strictEqual(server.socketServer.engine, server.socketServer.sockets.engine);
        });

        it('starts with a client count of zero', async () => {
            server = await createTestServer();
            assert.strictEqual(server.socketServer.engine.clientsCount, 0);
        });

        it('counts the connected clients', async () => {
            server = await createTestServer();

            await server.connectReady();
            assert.strictEqual(server.socketServer.engine.clientsCount, 1);

            await server.connectReady();
            assert.strictEqual(server.socketServer.engine.clientsCount, 2);

            await server.connectReady();
            assert.strictEqual(server.socketServer.engine.clientsCount, 3);
        });

        it('decrements the client count on disconnect', async () => {
            server = await createTestServer();
            const first = await server.connectReady();
            await server.connectReady();
            assert.strictEqual(server.socketServer.engine.clientsCount, 2);

            await first.close();
            await wait(200);

            assert.strictEqual(server.socketServer.engine.clientsCount, 1);
            assert.strictEqual(server.socketServer.sockets.sockets.length, 1);
        });
    });

    describe('on / off', () => {
        it('ignores on() without a callback', async () => {
            server = await createTestServer();
            assert.doesNotThrow(() => server.socketServer.on('connection', undefined));
        });

        it('removes a connection handler again', async () => {
            const calls = [];
            server = await createTestServer({ noConnectionHandler: true });

            const handler = (_socket, initDone) => {
                calls.push('removed');
                initDone();
            };
            server.socketServer.on('connection', handler);
            server.socketServer.on('connection', (_socket, initDone) => {
                calls.push('kept');
                initDone();
            });
            server.socketServer.off('connection', handler);

            await server.connectReady();
            assert.deepStrictEqual(calls, ['kept']);
        });

        it('ignores off() with an unknown callback', async () => {
            server = await createTestServer();
            assert.doesNotThrow(() => server.socketServer.off('connection', () => {}));
        });

        it('ignores off() for an unknown event', async () => {
            server = await createTestServer();
            assert.doesNotThrow(() => server.socketServer.off('does-not-exist', () => {}));
        });

        it('falls back to the immediate ready if the last connection handler was removed', async () => {
            server = await createTestServer({ noConnectionHandler: true });
            const handler = (_socket, initDone) => initDone();
            server.socketServer.on('connection', handler);
            server.socketServer.off('connection', handler);

            const client = server.connect();
            await client.opened;
            await client.waitForReady();
        });

        it('calls every registered error handler', async () => {
            const calls = [];
            server = await createTestServer();
            server.socketServer.on('error', (_name, error) => calls.push(error));

            const client = server.connect('/');
            await client.opened;
            await client.waitForMessage('error');

            // once via createTestServer(), once via the handler above
            assert.strictEqual(server.errors.length, 1);
            assert.strictEqual(calls.length, 1);
        });
    });

    describe('Broadcast', () => {
        it('sends sockets.emit() to all connected clients', async () => {
            server = await createTestServer();
            const first = await server.connectReady();
            const second = await server.connectReady();
            const third = await server.connectReady();

            server.socketServer.sockets.emit('broadcast', 'to everyone');

            assert.deepStrictEqual(await first.waitForMessage('broadcast'), ['to everyone']);
            assert.deepStrictEqual(await second.waitForMessage('broadcast'), ['to everyone']);
            assert.deepStrictEqual(await third.waitForMessage('broadcast'), ['to everyone']);
        });

        it('sends sockets.emit() without arguments', async () => {
            server = await createTestServer();
            const client = await server.connectReady();

            server.socketServer.sockets.emit('noArgs');

            assert.deepStrictEqual(await client.waitForMessage('noArgs'), []);
        });

        it('does nothing if nobody is connected', async () => {
            server = await createTestServer();
            assert.doesNotThrow(() => server.socketServer.sockets.emit('nobody'));
        });

        it('does not reach a client that already disconnected', async () => {
            server = await createTestServer();
            const staying = await server.connectReady();
            const leaving = await server.connectReady();

            await leaving.close();
            await wait(200);

            server.socketServer.sockets.emit('broadcast', 'after disconnect');
            await staying.waitForMessage('broadcast');

            const framesOfLeaving = leaving.frames.filter(
                e => Array.isArray(e.frame) && e.frame[2] === 'broadcast',
            );
            assert.deepStrictEqual(framesOfLeaving, []);
        });
    });

    describe('Several clients', () => {
        it('sends a message of one socket only to that client', async () => {
            server = await createTestServer();
            const first = await server.connectReady();
            const second = await server.connectReady();

            server.sockets[0].emit('onlyFirst', 1);
            await first.waitForMessage('onlyFirst');
            await wait(200);

            assert.deepStrictEqual(
                second.frames.filter(e => Array.isArray(e.frame) && e.frame[2] === 'onlyFirst'),
                [],
            );
        });

        it('keeps the handlers of the sockets separate', async () => {
            const received = [];
            server = await createTestServer({
                onConnection: (socket, initDone) => {
                    socket.on('who', () => received.push(socket.id));
                    initDone();
                },
            });

            const first = await server.connectReady();
            await server.connectReady();

            first.emit('who');
            await wait(200);

            assert.deepStrictEqual(received, [server.sockets[0].id]);
        });

        it('counts its own message ids per socket', async () => {
            server = await createTestServer();
            const first = await server.connectReady();
            const second = await server.connectReady();

            server.sockets[0].emit('a');
            server.sockets[0].emit('b');
            server.sockets[1].emit('a');

            await first.waitForMessage('b');
            await second.waitForMessage('a');

            const idOfSecond = second.frames.find(e => Array.isArray(e.frame) && e.frame[2] === 'a').frame[1];
            // "___ready___" is the first message of every socket, so "a" of the
            // second socket must be number 2
            assert.strictEqual(idOfSecond, 2);
        });

        it('serves 25 clients at the same time', async () => {
            server = await createTestServer({
                onConnection: (socket, initDone) => {
                    socket.on('echo', (value, cb) => cb(null, value));
                    initDone();
                },
            });

            const clients = await Promise.all(Array.from({ length: 25 }, () => server.connectReady()));
            assert.strictEqual(server.socketServer.engine.clientsCount, 25);

            const answers = await Promise.all(clients.map((client, i) => client.request('echo', i)));
            assert.deepStrictEqual(
                answers,
                Array.from({ length: 25 }, (_, i) => [null, i]),
            );
        });
    });

    describe('close', () => {
        it('closes all connections', async () => {
            server = await createTestServer();
            const first = await server.connectReady();
            const second = await server.connectReady();

            server.socketServer.close();

            await first.closed;
            await second.closed;
        });

        it('calls the disconnect handler of every socket', async () => {
            const disconnected = [];
            server = await createTestServer({
                onConnection: (socket, initDone) => {
                    socket.on('disconnect', () => disconnected.push(socket.id));
                    initDone();
                },
            });

            await server.connectReady();
            await server.connectReady();
            const ids = server.sockets.map(socket => socket.id);

            server.socketServer.close();
            await wait(200);

            assert.deepStrictEqual(disconnected.sort(), ids.sort());
        });

        it('can be called without any connection', async () => {
            server = await createTestServer();
            assert.doesNotThrow(() => server.socketServer.close());
        });
    });

    describe('Server to client', () => {
        it('transports an emit of the server to the client', async () => {
            server = await createTestServer();
            const client = await server.connectReady();

            server.socket.emit('fromServer', { some: 'payload' }, 42);

            assert.deepStrictEqual(await client.waitForMessage('fromServer'), [{ some: 'payload' }, 42]);
        });

        it('sends a message frame of type 0', async () => {
            server = await createTestServer();
            const client = await server.connectReady();

            server.socket.emit('fromServer');
            await client.waitForMessage('fromServer');

            const frame = client.frames.find(e => Array.isArray(e.frame) && e.frame[2] === 'fromServer').frame;
            assert.strictEqual(frame[0], MESSAGE_TYPES.MESSAGE);
        });

        it('swallows an emit to an already closed socket', async () => {
            server = await createTestServer();
            const client = await server.connectReady();
            const socket = server.socket;

            await client.close();
            await wait(200);

            assert.doesNotThrow(() => socket.emit('tooLate'));
        });
    });
});
