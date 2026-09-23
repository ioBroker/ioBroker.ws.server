'use strict';

const assert = require('node:assert');

const { MESSAGE_TYPES, UUID_PATTERN, captureConsole, createTestServer, wait } = require('./lib/helpers');

describe('Connection lifecycle', function () {
    this.timeout(15000);

    let server;

    afterEach(async () => {
        if (server) {
            await server.destroy();
            server = null;
        }
    });

    describe('Handshake', () => {
        it('sends "___ready___" after the connection handler called initDone()', async () => {
            server = await createTestServer();
            const client = server.connect();
            await client.opened;

            await client.waitForReady();
            assert.strictEqual(server.sockets.length, 1);
        });

        it('sends "___ready___" immediately if no connection handler is installed', async () => {
            server = await createTestServer({ noConnectionHandler: true });
            const client = server.connect();
            await client.opened;

            await client.waitForReady();
        });

        it('sends "___ready___" as a message frame without arguments', async () => {
            server = await createTestServer();
            const client = server.connect();
            await client.opened;
            await client.waitForReady();

            const frame = client.frames.find(e => Array.isArray(e.frame) && e.frame[2] === '___ready___').frame;
            assert.strictEqual(frame[0], MESSAGE_TYPES.MESSAGE);
            assert.strictEqual(frame.length, 3);
        });

        it('waits for initDone() before it announces that it is ready', async () => {
            let release;
            server = await createTestServer({
                onConnection: (_socket, initDone) => {
                    release = initDone;
                },
            });

            const client = server.connect();
            await client.opened;
            await wait(300);

            assert.strictEqual(
                client.frames.length,
                0,
                `Nothing may be sent before initDone(), got ${JSON.stringify(client.frames.map(e => e.frame))}`,
            );

            release();
            await client.waitForReady();
        });

        it('sends "___ready___" after 1.5 seconds even if initDone() is never called', async () => {
            server = await createTestServer({
                onConnection: () => {
                    // never call initDone()
                },
            });

            const client = server.connect();
            await client.opened;

            const start = Date.now();
            const captured = await captureConsole(() => client.waitForReady(4000));
            const duration = Date.now() - start;

            assert.ok(duration >= 1400, `The fallback must not fire earlier than 1.5 s, but fired after ${duration} ms`);
            assert.ok(duration < 3000, `The fallback must fire after ~1.5 s, but fired after ${duration} ms`);
            assert.ok(
                captured.warn.some(line => line.includes('Sent ready, but not all handlers installed!')),
                'The fallback must warn about the missing initDone()',
            );
        });

        it('does not send "___ready___" if initDone(true) selects a custom handler', async () => {
            server = await createTestServer({
                onConnection: (_socket, initDone) => initDone(true),
            });

            const client = server.connect();
            await client.opened;
            // Wait longer than the 1.5 s fallback
            await wait(2000);

            assert.deepStrictEqual(
                client.frames.map(e => e.frame),
                [],
                'A custom handler must not get a "___ready___"',
            );
            assert.strictEqual(client.readyState, 1, 'The connection must stay open');
        });

        it('calls initDone() only once effectively', async () => {
            server = await createTestServer({
                onConnection: (_socket, initDone) => {
                    initDone();
                    initDone();
                    initDone();
                },
            });

            const client = server.connect();
            await client.opened;
            await client.waitForReady();
            await wait(300);

            const readyFrames = client.frames.filter(e => Array.isArray(e.frame) && e.frame[2] === '___ready___');
            assert.strictEqual(readyFrames.length, 1);
        });

        it('calls every registered connection handler', async () => {
            const calls = [];
            server = await createTestServer({ noConnectionHandler: true });
            server.socketServer.on('connection', (_socket, initDone) => {
                calls.push('first');
                initDone();
            });
            server.socketServer.on('connection', (_socket, initDone) => {
                calls.push('second');
                initDone();
            });

            const client = server.connect();
            await client.opened;
            await client.waitForReady();

            assert.deepStrictEqual(calls, ['first', 'second']);
        });
    });

    describe('Missing session id', () => {
        it('rejects a connection without any query', async () => {
            server = await createTestServer();
            const client = server.connect('/');
            await client.opened;

            const frame = await client.waitForMessage('error');
            assert.deepStrictEqual(frame, ['invalid sid']);
        });

        it('sends the error with the message id 501', async () => {
            server = await createTestServer();
            const client = server.connect('/');
            await client.opened;
            await client.waitForMessage('error');

            const frame = client.frames.find(e => Array.isArray(e.frame) && e.frame[2] === 'error').frame;
            assert.strictEqual(frame[0], MESSAGE_TYPES.MESSAGE);
            assert.strictEqual(frame[1], 501);
        });

        it('rejects a connection with an empty sid', async () => {
            server = await createTestServer();
            const client = server.connect('/?sid=');
            await client.opened;

            assert.deepStrictEqual(await client.waitForMessage('error'), ['invalid sid']);
        });

        it('rejects a connection whose query has no sid at all', async () => {
            server = await createTestServer();
            const client = server.connect('/?name=test&token=abc');
            await client.opened;

            assert.deepStrictEqual(await client.waitForMessage('error'), ['invalid sid']);
        });

        it('closes the connection afterwards', async () => {
            server = await createTestServer();
            const client = server.connect('/');
            await client.opened;
            await client.waitForMessage('error');

            await client.closed;
            assert.ok(client.closeEvent, 'The connection must be closed by the server');
        });

        it('does not create a socket', async () => {
            server = await createTestServer();
            const client = server.connect('/');
            await client.opened;
            await client.waitForMessage('error');

            assert.strictEqual(server.sockets.length, 0);
            assert.strictEqual(server.socketServer.engine.clientsCount, 0);
        });

        it('reports the problem including the IP via the "error" event', async () => {
            server = await createTestServer();
            const client = server.connect('/');
            await client.opened;
            await client.waitForMessage('error');

            assert.strictEqual(server.errors.length, 1);
            assert.strictEqual(server.errors[0].name, 'error');
            assert.match(server.errors[0].error, /^No sid found from .*127\.0\.0\.1/);
        });

        it('accepts a sid that only consists of a zero', async () => {
            server = await createTestServer();
            const client = server.connect('/?sid=0');
            await client.opened;

            await client.waitForReady();
            assert.strictEqual(server.sockets.length, 1);
        });
    });

    describe('Middleware (use)', () => {
        it('passes the request of the upgrade to the middleware', async () => {
            const requests = [];
            server = await createTestServer({
                use: [
                    (req, next) => {
                        requests.push(req);
                        next(false);
                    },
                ],
            });

            await server.connectReady('/?sid=1&name=middlewareTest');

            assert.strictEqual(requests.length, 1);
            assert.match(requests[0].url, /^\/\?sid=1&name=middlewareTest$/);
            assert.strictEqual(requests[0].method, 'GET');
        });

        it('lets the connection through if the middleware reports no error', async () => {
            server = await createTestServer({ use: [(_req, next) => next(false)] });

            await server.connectReady();
            assert.strictEqual(server.sockets.length, 1);
        });

        it('sends "reauthenticate" if the middleware reports an error', async () => {
            server = await createTestServer({ use: [(_req, next) => next(true)] });

            const client = server.connect();
            await client.opened;

            await client.waitForMessage('reauthenticate');
            assert.strictEqual(server.sockets.length, 0, 'No socket may be created for a rejected client');
        });

        it('sends "reauthenticate" with the message id 401', async () => {
            server = await createTestServer({ use: [(_req, next) => next(true)] });

            const client = server.connect();
            await client.opened;
            await client.waitForMessage('reauthenticate');

            const frame = client.frames.find(e => Array.isArray(e.frame) && e.frame[2] === 'reauthenticate').frame;
            assert.strictEqual(frame[0], MESSAGE_TYPES.MESSAGE);
            assert.strictEqual(frame[1], 401);
        });

        it('closes a rejected connection', async () => {
            server = await createTestServer({ use: [(_req, next) => next(true)] });

            const client = server.connect();
            await client.opened;
            await client.waitForMessage('reauthenticate');

            await client.closed;
        });

        it('reports the failed authentication including the IP via the "error" event', async () => {
            server = await createTestServer({ use: [(_req, next) => next(true)] });

            const client = server.connect();
            await client.opened;
            await client.waitForMessage('reauthenticate');

            assert.strictEqual(server.errors.length, 1);
            assert.match(server.errors[0].error, /^authentication failed for .*127\.0\.0\.1/);
        });

        it('prefers the x-forwarded-for header for the reported IP', async () => {
            server = await createTestServer({ use: [(_req, next) => next(true)] });

            const client = server.connect(undefined, { headers: { 'x-forwarded-for': '10.11.12.13' } });
            await client.opened;
            await client.waitForMessage('reauthenticate');

            assert.match(server.errors[0].error, /10\.11\.12\.13/);
        });

        it('runs all middlewares', async () => {
            const calls = [];
            server = await createTestServer({
                use: [
                    (_req, next) => {
                        calls.push('first');
                        next(false);
                    },
                    (_req, next) => {
                        calls.push('second');
                        next(false);
                    },
                    (_req, next) => {
                        calls.push('third');
                        next(false);
                    },
                ],
            });

            await server.connectReady();
            assert.deepStrictEqual(calls, ['first', 'second', 'third']);
        });

        it('rejects the client if one of several middlewares reports an error', async () => {
            server = await createTestServer({
                use: [(_req, next) => next(false), (_req, next) => next(true), (_req, next) => next(false)],
            });

            const client = server.connect();
            await client.opened;

            await client.waitForMessage('reauthenticate');
        });

        it('waits for all asynchronous middlewares before it decides', async () => {
            const finished = [];
            server = await createTestServer({
                use: [
                    (_req, next) => setTimeout(() => (finished.push('slow'), next(false)), 200),
                    (_req, next) => setTimeout(() => (finished.push('fast'), next(true)), 20),
                ],
            });

            const client = server.connect();
            await client.opened;
            await client.waitForMessage('reauthenticate');

            assert.deepStrictEqual(finished, ['fast', 'slow'], 'Both middlewares must have finished');
        });

        it('does not establish the connection while a middleware does not answer', async () => {
            server = await createTestServer({ use: [() => {}] });

            const client = server.connect();
            await wait(700);

            assert.notStrictEqual(client.readyState, 1, 'The upgrade must not be completed');
        });

        it('use() returns the server for chaining', async () => {
            server = await createTestServer({ noConnectionHandler: true });
            const returned = server.socketServer.use((_req, next) => next(false));

            assert.strictEqual(returned, server.socketServer);
        });

        it('a middleware can add the session id to the request', async () => {
            server = await createTestServer({
                use: [
                    (req, next) => {
                        req.sessionID = 'session-from-middleware';
                        next(false);
                    },
                ],
            });

            await server.connectReady();
            assert.strictEqual(server.socket.conn.request.sessionID, 'session-from-middleware');
        });
    });

    describe('Socket properties', () => {
        it('generates a random UUID as socket id', async () => {
            server = await createTestServer();
            await server.connectReady('/?sid=my-own-id');

            assert.match(server.socket.id, UUID_PATTERN);
            assert.notStrictEqual(server.socket.id, 'my-own-id');
        });

        it('keeps the session id empty without a real session', async () => {
            server = await createTestServer();
            await server.connectReady('/?sid=12345');

            assert.strictEqual(server.socket.conn.request.sessionID, '');
        });

        it('parses the complete query', async () => {
            server = await createTestServer();
            await server.connectReady('/?sid=1&name=admin.0&token=abc&flag=');

            // querystring.parse() returns an object without prototype
            assert.deepStrictEqual({ ...server.socket.query }, { sid: '1', name: 'admin.0', token: 'abc', flag: '' });
            assert.strictEqual(server.socket.conn.request.query, server.socket.query);
        });

        it('takes the name from the query', async () => {
            server = await createTestServer();
            await server.connectReady('/?sid=1&name=admin.0');

            assert.strictEqual(server.socket._name, 'admin.0');
        });

        it('leaves the name undefined if the query has none', async () => {
            server = await createTestServer();
            await server.connectReady('/?sid=1');

            assert.strictEqual(server.socket._name, undefined);
        });

        it('decodes url encoded query values', async () => {
            server = await createTestServer();
            await server.connectReady(`/?sid=1&name=${encodeURIComponent('my adapter.0')}`);

            assert.strictEqual(server.socket._name, 'my adapter.0');
        });

        it('stores the path without the query as pathname', async () => {
            server = await createTestServer();
            await server.connectReady('/my/own/path?sid=1');

            assert.strictEqual(server.socket.conn.request.pathname, '/my/own/path');
        });

        it('stores the remote address', async () => {
            server = await createTestServer();
            await server.connectReady();

            assert.match(server.socket.connection.remoteAddress, /127\.0\.0\.1$/);
        });

        it('stores the cookie header', async () => {
            server = await createTestServer();
            await server.connectReady(undefined, { headers: { cookie: 'connect.sid=s%3Aabc; other=1' } });

            assert.strictEqual(server.socket.conn.request.headers.cookie, 'connect.sid=s%3Aabc; other=1');
        });

        it('stores the authorization header in conn.request.headers and conn.authorization', async () => {
            server = await createTestServer();
            await server.connectReady(undefined, { headers: { authorization: 'Bearer my-token' } });

            assert.strictEqual(server.socket.conn.request.headers.authorization, 'Bearer my-token');
            assert.strictEqual(server.socket.conn.authorization, 'Bearer my-token');
        });

        it('initialises the fields used by @iobroker/socket-classes', async () => {
            server = await createTestServer();
            await server.connectReady();

            const socket = server.socket;
            assert.strictEqual(socket._secure, false);
            assert.strictEqual(socket._acl, null);
            assert.strictEqual(socket._sessionID, undefined);
            assert.strictEqual(socket.subscribe, undefined);
            assert.strictEqual(socket._authPending, undefined);
            assert.strictEqual(socket._lastActivity, undefined);
            assert.strictEqual(socket._sessionTimer, undefined);
            assert.strictEqual(socket._sessionExpiresAt, undefined);
            assert.ok(socket.ws, 'The raw web socket must be accessible');
        });

        it('gives every connection its own socket id', async () => {
            server = await createTestServer();
            await server.connectReady('/?sid=same');
            await server.connectReady('/?sid=same');
            await server.connectReady('/?sid=same');

            const ids = server.sockets.map(socket => socket.id);
            assert.strictEqual(new Set(ids).size, 3, `The ids must differ: ${ids.join(', ')}`);
        });
    });

    describe('Disconnect', () => {
        it('calls the "disconnect" handler when the client closes', async () => {
            let disconnected = false;
            server = await createTestServer({
                onConnection: (socket, initDone) => {
                    socket.on('disconnect', () => (disconnected = true));
                    initDone();
                },
            });

            const client = await server.connectReady();
            await client.close();
            await wait(200);

            assert.strictEqual(disconnected, true);
        });

        it('calls the "disconnect" handler when the connection is terminated hard', async () => {
            let disconnected = false;
            server = await createTestServer({
                onConnection: (socket, initDone) => {
                    socket.on('disconnect', () => (disconnected = true));
                    initDone();
                },
            });

            const client = await server.connectReady();
            client.terminate();
            await wait(300);

            assert.strictEqual(disconnected, true);
        });

        it('removes the socket from the list of the server', async () => {
            server = await createTestServer();
            const client = await server.connectReady();

            assert.strictEqual(server.socketServer.sockets.sockets.length, 1);
            await client.close();
            await wait(200);

            assert.strictEqual(server.socketServer.sockets.sockets.length, 0);
        });

        it('closes the connection from the server side via socket.close()', async () => {
            server = await createTestServer();
            const client = await server.connectReady();

            server.socket.close();
            await client.closed;
        });

        it('closes the connection from the server side via socket.disconnect()', async () => {
            server = await createTestServer();
            const client = await server.connectReady();

            server.socket.disconnect();
            await client.closed;
        });

        it('survives calling close() twice', async () => {
            let disconnects = 0;
            server = await createTestServer({
                onConnection: (socket, initDone) => {
                    socket.on('disconnect', () => disconnects++);
                    initDone();
                },
            });

            const client = await server.connectReady();
            server.socket.close();
            server.socket.close();
            await client.closed;
            await wait(200);

            assert.strictEqual(disconnects, 1, 'The disconnect handler must only be called once');
        });
    });
});
