'use strict';

const assert = require('node:assert');

const { MESSAGE_TYPES, captureConsole, createTestServer, wait } = require('./lib/helpers');

describe('Wire protocol', function () {
    this.timeout(15000);

    let server;

    afterEach(async () => {
        if (server) {
            await server.destroy();
            server = null;
        }
    });

    describe('MESSAGE (type 0)', () => {
        it('calls the handler of the event with all arguments', async () => {
            const received = [];
            server = await createTestServer({
                onConnection: (socket, initDone) => {
                    socket.on('hello', (...args) => received.push(args));
                    initDone();
                },
            });

            const client = await server.connectReady();
            client.emit('hello', 1, 'two', { three: 3 }, [4], null, true);

            await wait(100);
            assert.deepStrictEqual(received, [[1, 'two', { three: 3 }, [4], null, true]]);
        });

        it('calls the handler without arguments if the frame has no argument array', async () => {
            const received = [];
            server = await createTestServer({
                onConnection: (socket, initDone) => {
                    socket.on('noArgs', (...args) => received.push(args));
                    initDone();
                },
            });

            const client = await server.connectReady();
            client.emit('noArgs');

            await wait(100);
            assert.deepStrictEqual(received, [[]]);
        });

        it('calls every handler that was installed for the same event', async () => {
            const calls = [];
            server = await createTestServer({
                onConnection: (socket, initDone) => {
                    socket.on('multi', value => calls.push(`first:${value}`));
                    socket.on('multi', value => calls.push(`second:${value}`));
                    initDone();
                },
            });

            const client = await server.connectReady();
            client.emit('multi', 42);

            await wait(100);
            assert.deepStrictEqual(calls, ['first:42', 'second:42']);
        });

        it('binds `this` of the handler to the socket', async () => {
            let self = null;
            server = await createTestServer({
                onConnection: (socket, initDone) => {
                    socket.on('who', function () {
                        self = this;
                    });
                    initDone();
                },
            });

            const client = await server.connectReady();
            client.emit('who');

            await wait(100);
            assert.strictEqual(self, server.socket);
        });

        it('ignores an event without a handler', async () => {
            server = await createTestServer();
            const client = await server.connectReady();

            client.emit('nobodyListens', 1);
            // The connection must stay usable
            await client.ping();
            assert.strictEqual(client.readyState, 1);
        });

        it('keeps the message order of several events', async () => {
            const order = [];
            server = await createTestServer({
                onConnection: (socket, initDone) => {
                    socket.on('step', value => order.push(value));
                    initDone();
                },
            });

            const client = await server.connectReady();
            for (let i = 0; i < 20; i++) {
                client.emit('step', i);
            }

            await wait(200);
            assert.deepStrictEqual(
                order,
                Array.from({ length: 20 }, (_, i) => i),
            );
        });
    });

    describe('CALLBACK (type 3)', () => {
        it('answers with the same message id and event name', async () => {
            server = await createTestServer({
                onConnection: (socket, initDone) => {
                    socket.on('add', (value, cb) => cb(null, value + 1));
                    initDone();
                },
            });

            const client = await server.connectReady();
            const answer = await client.requestFull('add', 41);

            assert.strictEqual(answer.name, 'add');
            assert.deepStrictEqual(answer.args, [null, 42]);

            const frame = client.frames.find(
                e => Array.isArray(e.frame) && e.frame[0] === MESSAGE_TYPES.CALLBACK && e.frame[1] === answer.id,
            );
            assert.ok(frame, 'The answer must use the id of the request');
        });

        it('transports all answer arguments', async () => {
            server = await createTestServer({
                onConnection: (socket, initDone) => {
                    socket.on('many', cb => cb(null, 1, 'two', { three: 3 }, [4]));
                    initDone();
                },
            });

            const client = await server.connectReady();
            assert.deepStrictEqual(await client.request('many'), [null, 1, 'two', { three: 3 }, [4]]);
        });

        it('sends a frame without an argument array if the callback is called without arguments', async () => {
            server = await createTestServer({
                onConnection: (socket, initDone) => {
                    socket.on('empty', cb => cb());
                    initDone();
                },
            });

            const client = await server.connectReady();
            const answer = await client.requestFull('empty');

            assert.deepStrictEqual(answer.args, []);
            const frame = client.frames.find(
                e => Array.isArray(e.frame) && e.frame[0] === MESSAGE_TYPES.CALLBACK && e.frame[1] === answer.id,
            ).frame;
            assert.strictEqual(frame.length, 3, 'An empty answer must not contain an argument array');
        });

        it('converts an Error in the first answer argument into a string', async () => {
            server = await createTestServer({
                onConnection: (socket, initDone) => {
                    socket.on('fail', cb => cb(new Error('Something went wrong')));
                    initDone();
                },
            });

            const client = await server.connectReady();
            assert.deepStrictEqual(await client.request('fail'), ['Error: Something went wrong']);
        });

        it('keeps an Error that is not the first argument untouched', async () => {
            server = await createTestServer({
                onConnection: (socket, initDone) => {
                    socket.on('fail', cb => cb(null, new Error('Not converted')));
                    initDone();
                },
            });

            const client = await server.connectReady();
            // JSON.stringify() of an Error results in an empty object
            assert.deepStrictEqual(await client.request('fail'), [null, {}]);
        });

        it('answers a request that was sent with an empty argument list', async () => {
            server = await createTestServer({
                onConnection: (socket, initDone) => {
                    socket.on('now', cb => cb(null, 'answer'));
                    initDone();
                },
            });

            const client = await server.connectReady();
            const answerPromise = client.waitForFrame(
                e => Array.isArray(e.frame) && e.frame[0] === MESSAGE_TYPES.CALLBACK && e.frame[2] === 'now',
                'answer of "now"',
            );
            client.sendRaw(JSON.stringify([MESSAGE_TYPES.CALLBACK, 4711, 'now', []]));

            const frame = await answerPromise;
            assert.strictEqual(frame[1], 4711);
            assert.deepStrictEqual(frame[3], [null, 'answer']);
        });

        it('passes the callback as the only argument if the request had no arguments', async () => {
            let argumentCount = -1;
            server = await createTestServer({
                onConnection: (socket, initDone) => {
                    socket.on('now', function (...args) {
                        argumentCount = args.length;
                        args[args.length - 1](null, 'answer');
                    });
                    initDone();
                },
            });

            const client = await server.connectReady();
            assert.deepStrictEqual(await client.request('now'), [null, 'answer']);
            assert.strictEqual(argumentCount, 1);
        });

        it('answers several parallel requests with the matching ids', async () => {
            server = await createTestServer({
                onConnection: (socket, initDone) => {
                    socket.on('delay', (ms, value, cb) => setTimeout(() => cb(null, value), ms));
                    initDone();
                },
            });

            const client = await server.connectReady();
            const answers = await Promise.all([
                client.request('delay', 120, 'slow'),
                client.request('delay', 10, 'fast'),
                client.request('delay', 60, 'middle'),
            ]);

            assert.deepStrictEqual(answers, [[null, 'slow'], [null, 'fast'], [null, 'middle']]);
        });

        it('calls every handler of the event, so every handler can answer', async () => {
            server = await createTestServer({
                onConnection: (socket, initDone) => {
                    socket.on('twice', cb => cb(null, 'first'));
                    socket.on('twice', cb => cb(null, 'second'));
                    initDone();
                },
            });

            const client = await server.connectReady();
            await client.request('twice');
            await wait(100);

            const answers = client.frames
                .filter(e => Array.isArray(e.frame) && e.frame[0] === MESSAGE_TYPES.CALLBACK)
                .map(e => e.frame[3]);
            assert.deepStrictEqual(answers, [[null, 'first'], [null, 'second']]);
        });

        it('does not answer if no handler is installed for the event', async () => {
            server = await createTestServer();
            const client = await server.connectReady();

            client.sendRaw(JSON.stringify([MESSAGE_TYPES.CALLBACK, 99, 'unknown', []]));
            await wait(200);

            const answers = client.frames.filter(
                e => Array.isArray(e.frame) && e.frame[0] === MESSAGE_TYPES.CALLBACK,
            );
            assert.deepStrictEqual(answers, []);
        });
    });

    describe('PING / PONG (type 1 / 2)', () => {
        it('answers a ping of the client with a pong', async () => {
            server = await createTestServer();
            const client = await server.connectReady();

            const pong = await client.ping();
            assert.deepStrictEqual(pong, [MESSAGE_TYPES.PONG]);
        });

        it('answers every ping', async () => {
            server = await createTestServer();
            const client = await server.connectReady();

            await client.ping();
            await client.ping();
            await client.ping();

            const pongs = client.frames.filter(e => Array.isArray(e.frame) && e.frame[0] === MESSAGE_TYPES.PONG);
            assert.strictEqual(pongs.length, 3);
        });

        it('accepts a pong of the client without answering', async () => {
            server = await createTestServer();
            const client = await server.connectReady();

            client.sendRaw(JSON.stringify([MESSAGE_TYPES.PONG]));
            await wait(200);

            assert.strictEqual(client.readyState, 1);
            const unexpected = client.frames.filter(e => !e.claimed);
            assert.deepStrictEqual(unexpected, [], 'A pong must not be answered');
        });
    });

    describe('Invalid input', () => {
        it('survives a frame that is not valid JSON', async () => {
            server = await createTestServer();
            const client = await server.connectReady();

            const captured = await captureConsole(async () => {
                client.sendRaw('this is not json');
                await wait(200);
            });

            assert.strictEqual(captured.error.length, 1);
            assert.match(captured.error[0], /Received invalid event/);
            // The connection must still work
            await client.ping();
        });

        it('survives a binary frame', async () => {
            server = await createTestServer();
            const client = await server.connectReady();

            const captured = await captureConsole(async () => {
                client.sendRaw(Buffer.from([0, 1, 2, 3]));
                await wait(200);
            });

            assert.strictEqual(captured.error.length, 1);
            assert.match(captured.error[0], /Received invalid event/);
            await client.ping();
        });

        it('survives an empty frame', async () => {
            server = await createTestServer();
            const client = await server.connectReady();

            const captured = await captureConsole(async () => {
                client.sendRaw('');
                await wait(200);
            });

            assert.strictEqual(captured.error.length, 1);
            await client.ping();
        });

        it('reports an unknown message type without closing the connection', async () => {
            server = await createTestServer();
            const client = await server.connectReady();

            const captured = await captureConsole(async () => {
                client.sendRaw(JSON.stringify([99, 1, 'strange']));
                await wait(200);
            });

            assert.ok(
                captured.log.some(line => line.includes('Received unknown event type: 99')),
                `Expected a log about the unknown type, got ${JSON.stringify(captured.log)}`,
            );
            await client.ping();
        });

        it('survives a JSON frame that is not an array', async () => {
            server = await createTestServer();
            const client = await server.connectReady();

            await captureConsole(async () => {
                client.sendRaw(JSON.stringify({ type: 0, name: 'hello' }));
                await wait(200);
            });

            assert.strictEqual(client.readyState, 1);
            await client.ping();
        });

    });

    /**
     * These frames are never produced by `@iobroker/ws`, but any other client can
     * send them. A server must not die because of them.
     */
    describe('Robustness against malformed frames', () => {
        it('survives a MESSAGE frame whose argument list is not an array', async () => {
            const received = [];
            server = await createTestServer({
                onConnection: (socket, initDone) => {
                    socket.on('broken', (...args) => received.push(args));
                    initDone();
                },
            });

            const client = await server.connectReady();
            client.sendRaw(JSON.stringify([MESSAGE_TYPES.MESSAGE, 1, 'broken', 'not-an-array']));
            await wait(200);

            assert.strictEqual(client.readyState, 1);
            await client.ping();
        });

        it('survives a MESSAGE frame with a non-array argument list on the wildcard handler', async () => {
            server = await createTestServer({
                onConnection: (socket, initDone) => {
                    socket.on('*', () => {});
                    initDone();
                },
            });

            const client = await server.connectReady();
            client.sendRaw(JSON.stringify([MESSAGE_TYPES.MESSAGE, 1, 'anything', 42]));
            await wait(200);

            assert.strictEqual(client.readyState, 1);
            await client.ping();
        });

        it('survives a CALLBACK frame without an argument list', async () => {
            server = await createTestServer({
                onConnection: (socket, initDone) => {
                    socket.on('now', cb => cb(null, 'answer'));
                    initDone();
                },
            });

            const client = await server.connectReady();
            client.sendRaw(JSON.stringify([MESSAGE_TYPES.CALLBACK, 4711, 'now']));
            await wait(200);

            assert.strictEqual(client.readyState, 1);
            await client.ping();
        });

        it('survives a CALLBACK frame whose argument list is not an array', async () => {
            server = await createTestServer({
                onConnection: (socket, initDone) => {
                    socket.on('now', cb => cb(null, 'answer'));
                    initDone();
                },
            });

            const client = await server.connectReady();
            client.sendRaw(JSON.stringify([MESSAGE_TYPES.CALLBACK, 4712, 'now', 42]));
            await wait(200);

            assert.strictEqual(client.readyState, 1);
            await client.ping();
        });

        it('survives a MESSAGE frame whose event name is inherited from Object.prototype', async () => {
            server = await createTestServer();
            const client = await server.connectReady();

            for (const name of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
                client.sendRaw(JSON.stringify([MESSAGE_TYPES.MESSAGE, 1, name, []]));
            }
            await wait(300);

            assert.strictEqual(client.readyState, 1);
            await client.ping();
        });

        it('survives a CALLBACK frame whose event name is inherited from Object.prototype', async () => {
            server = await createTestServer();
            const client = await server.connectReady();

            for (const name of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
                client.sendRaw(JSON.stringify([MESSAGE_TYPES.CALLBACK, 1, name, []]));
            }
            await wait(300);

            assert.strictEqual(client.readyState, 1);
            await client.ping();
        });

        it('does not confuse a wildcard handler with an inherited event name', async () => {
            const received = [];
            server = await createTestServer({
                onConnection: (socket, initDone) => {
                    socket.on('*', (...args) => received.push(args));
                    initDone();
                },
            });

            const client = await server.connectReady();
            client.sendRaw(JSON.stringify([MESSAGE_TYPES.MESSAGE, 1, 'toString', ['x']]));
            await wait(300);

            assert.strictEqual(client.readyState, 1);
            assert.deepStrictEqual(received, [['toString', 'x']]);
        });
    });

    describe('Payload', () => {
        it('transports a payload of one megabyte in both directions', async () => {
            const payload = 'x'.repeat(1024 * 1024);
            server = await createTestServer({
                onConnection: (socket, initDone) => {
                    socket.on('echo', (data, cb) => cb(null, data));
                    initDone();
                },
            });

            const client = await server.connectReady();
            const answer = await client.request('echo', payload);

            assert.strictEqual(answer[1].length, payload.length);
            assert.strictEqual(answer[1], payload);
        });

        it('transports unicode characters unchanged', async () => {
            const payload = 'Grüße – 日本語 – 🚀 – "quotes" – \\backslash\\ – \n\t';
            server = await createTestServer({
                onConnection: (socket, initDone) => {
                    socket.on('echo', (data, cb) => cb(null, data));
                    initDone();
                },
            });

            const client = await server.connectReady();
            assert.deepStrictEqual(await client.request('echo', payload), [null, payload]);
        });

        it('transports deeply nested objects unchanged', async () => {
            const payload = { a: [{ b: { c: [1, 2, { d: null }] } }], e: 'f' };
            server = await createTestServer({
                onConnection: (socket, initDone) => {
                    socket.on('echo', (data, cb) => cb(null, data));
                    initDone();
                },
            });

            const client = await server.connectReady();
            assert.deepStrictEqual(await client.request('echo', payload), [null, payload]);
        });
    });
});
