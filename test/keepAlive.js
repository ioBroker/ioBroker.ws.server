'use strict';

const assert = require('node:assert');

const { MESSAGE_TYPES, createTestServer, wait } = require('./lib/helpers');

/**
 * The keep alive of the server works with a 5 seconds timer:
 * after 5 s without traffic it sends a ping, after 15 s it closes the connection.
 * Therefore these tests need real time and are kept in their own file.
 */
describe('Keep alive', function () {
    this.timeout(40000);

    let server;

    afterEach(async () => {
        if (server) {
            await server.destroy();
            server = null;
        }
    });

    it('sends a ping after about 5 seconds without traffic', async () => {
        server = await createTestServer();
        const client = await server.connectReady();

        const start = Date.now();
        const frame = await client.waitForType(MESSAGE_TYPES.PING, 9000);
        const duration = Date.now() - start;

        assert.deepStrictEqual(frame, [MESSAGE_TYPES.PING]);
        assert.ok(duration >= 4000, `The ping came too early, after ${duration} ms`);
        assert.ok(duration < 8000, `The ping came too late, after ${duration} ms`);
    });

    it('sends further pings as long as the client keeps silent', async () => {
        server = await createTestServer();
        const client = await server.connectReady();

        await client.waitForType(MESSAGE_TYPES.PING, 9000);
        await client.waitForType(MESSAGE_TYPES.PING, 9000);

        const pings = client.frames.filter(e => Array.isArray(e.frame) && e.frame[0] === MESSAGE_TYPES.PING);
        assert.ok(pings.length >= 2, `Expected at least 2 pings, got ${pings.length}`);
    });

    it('closes the connection after about 15 seconds without any answer', async () => {
        let disconnected = false;
        server = await createTestServer({
            onConnection: (socket, initDone) => {
                socket.on('disconnect', () => (disconnected = true));
                initDone();
            },
        });

        const client = await server.connectReady();
        const start = Date.now();

        await client.closed;
        const duration = Date.now() - start;

        assert.ok(duration >= 13000, `The connection was closed too early, after ${duration} ms`);
        assert.ok(duration < 20000, `The connection was closed too late, after ${duration} ms`);
        assert.strictEqual(disconnected, true, 'The disconnect handler must be called');
        assert.strictEqual(server.socketServer.engine.clientsCount, 0);
    });

    it('keeps the connection if the client answers the pings', async () => {
        server = await createTestServer();
        const client = server.connect();
        client.autoPong();
        await client.opened;
        await client.waitForReady();

        await wait(18000);

        assert.strictEqual(client.readyState, 1, 'The connection must still be open');
        assert.strictEqual(client.closeEvent, null);
        assert.strictEqual(server.socketServer.engine.clientsCount, 1);

        const pings = client.frames.filter(e => Array.isArray(e.frame) && e.frame[0] === MESSAGE_TYPES.PING);
        assert.ok(pings.length >= 1, 'The server must have sent at least one ping');
    });

    it('keeps the connection if the client sends normal messages', async () => {
        server = await createTestServer({
            onConnection: (socket, initDone) => {
                socket.on('alive', () => {});
                initDone();
            },
        });

        const client = await server.connectReady();

        for (let i = 0; i < 9; i++) {
            await wait(2000);
            client.emit('alive', i);
        }

        assert.strictEqual(client.readyState, 1, 'The connection must still be open');
        assert.strictEqual(client.closeEvent, null);
    });
});
