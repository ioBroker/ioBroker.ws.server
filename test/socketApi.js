'use strict';

const assert = require('node:assert');

const { MESSAGE_TYPES, UUID_PATTERN, Socket, captureConsole, wait } = require('./lib/helpers');

/**
 * A minimal stand-in for the web socket of the `ws` package.
 *
 * It records everything that the `Socket` sends and allows to push frames
 * into `Socket` without a real network connection.
 */
class FakeWebSocket {
    constructor() {
        /** Everything that was sent, already parsed */
        this.sent = [];
        /** Everything that was sent, as raw string */
        this.sentRaw = [];
        this.closeCalls = 0;
        this.failSend = false;
        this.failClose = false;
        this.onmessage = null;
        this.onclose = null;
        this.onerror = null;
    }

    send(data) {
        if (this.failSend) {
            throw new Error('WebSocket is not open');
        }
        this.sentRaw.push(data);
        this.sent.push(JSON.parse(data));
    }

    close() {
        this.closeCalls++;
        if (this.failClose) {
            throw new Error('Cannot close');
        }
    }

    /** Simulate an incoming frame */
    receive(frame) {
        this.onmessage({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) });
    }

    /** Simulate an incoming frame with arbitrary payload, e.g. a Buffer */
    receiveRaw(data) {
        this.onmessage({ data });
    }

    /** All frames of the given type */
    ofType(type) {
        return this.sent.filter(frame => frame[0] === type);
    }
}

function createSocket(options = {}) {
    const ws = new FakeWebSocket();
    const socket = new Socket(ws, {
        sessionID: '',
        query: { sid: '1' },
        remoteAddress: '127.0.0.1',
        pathname: '/',
        ...options,
    });
    return { ws, socket };
}

describe('Socket API', function () {
    this.timeout(10000);

    /** All sockets of the running test, closed afterwards to stop the ping timers */
    let open;

    beforeEach(() => {
        open = [];
    });

    afterEach(() => {
        open.forEach(socket => socket.close());
        open = [];
    });

    function make(options) {
        const created = createSocket(options);
        open.push(created.socket);
        return created;
    }

    describe('Constructor', () => {
        it('generates a UUID if no id is given', () => {
            const { socket } = make();
            assert.match(socket.id, UUID_PATTERN);
        });

        it('uses the given id', () => {
            const { socket } = make({ id: 'my-id' });
            assert.strictEqual(socket.id, 'my-id');
        });

        it('builds the socket.io compatible conn object', () => {
            const { socket } = make({
                sessionID: 'session',
                query: { sid: '1', name: 'admin' },
                pathname: '/path',
                cookie: 'a=b',
                authorization: 'Bearer x',
            });

            assert.deepStrictEqual(socket.conn, {
                request: {
                    sessionID: 'session',
                    pathname: '/path',
                    query: { sid: '1', name: 'admin' },
                    headers: { cookie: 'a=b', authorization: 'Bearer x' },
                },
                authorization: 'Bearer x',
            });
        });

        it('takes _name from the query', () => {
            const { socket } = make({ query: { sid: '1', name: 'web.0' } });
            assert.strictEqual(socket._name, 'web.0');
        });
    });

    describe('emit', () => {
        it('sends a message frame without an argument array if there are no arguments', () => {
            const { ws, socket } = make();
            socket.emit('hello');

            assert.deepStrictEqual(ws.sent, [[MESSAGE_TYPES.MESSAGE, 1, 'hello']]);
        });

        it('sends the arguments as an array', () => {
            const { ws, socket } = make();
            socket.emit('hello', 1, 'two', { three: 3 });

            assert.deepStrictEqual(ws.sent, [[MESSAGE_TYPES.MESSAGE, 1, 'hello', [1, 'two', { three: 3 }]]]);
        });

        it('increments the message id with every call', () => {
            const { ws, socket } = make();
            socket.emit('a');
            socket.emit('b');
            socket.emit('c');

            assert.deepStrictEqual(
                ws.sent.map(frame => frame[1]),
                [1, 2, 3],
            );
        });

        it('swallows an error of the underlying socket', () => {
            const { ws, socket } = make();
            ws.failSend = true;

            assert.doesNotThrow(() => socket.emit('hello'));
        });

        it('keeps counting the message id after a failed send', () => {
            const { ws, socket } = make();
            ws.failSend = true;
            socket.emit('lost');
            ws.failSend = false;
            socket.emit('arrived');

            assert.deepStrictEqual(ws.sent, [[MESSAGE_TYPES.MESSAGE, 2, 'arrived']]);
        });
    });

    describe('on / off', () => {
        it('calls a handler of an incoming message', async () => {
            const { ws, socket } = make();
            const calls = [];
            socket.on('event', (...args) => calls.push(args));

            ws.receive([MESSAGE_TYPES.MESSAGE, 1, 'event', ['a', 'b']]);
            await wait(20);

            assert.deepStrictEqual(calls, [['a', 'b']]);
        });

        it('ignores on() without a callback', () => {
            const { socket } = make();
            assert.doesNotThrow(() => socket.on('event', undefined));
        });

        it('removes a single handler by reference', async () => {
            const { ws, socket } = make();
            const calls = [];
            const first = () => calls.push('first');
            const second = () => calls.push('second');
            socket.on('event', first);
            socket.on('event', second);

            socket.off('event', first);
            ws.receive([MESSAGE_TYPES.MESSAGE, 1, 'event', []]);
            await wait(20);

            assert.deepStrictEqual(calls, ['second']);
        });

        it('ignores off() with a handler that was never installed', async () => {
            const { ws, socket } = make();
            const calls = [];
            socket.on('event', () => calls.push('installed'));

            socket.off('event', () => {});
            ws.receive([MESSAGE_TYPES.MESSAGE, 1, 'event', []]);
            await wait(20);

            assert.deepStrictEqual(calls, ['installed']);
        });

        it('removes all handlers of an event if no callback is given', async () => {
            const { ws, socket } = make();
            const calls = [];
            socket.on('event', () => calls.push('first'));
            socket.on('event', () => calls.push('second'));

            socket.off('event');
            ws.receive([MESSAGE_TYPES.MESSAGE, 1, 'event', []]);
            await wait(20);

            assert.deepStrictEqual(calls, []);
        });

        it('removes the handlers of all events if no name is given', async () => {
            const { ws, socket } = make();
            const calls = [];
            socket.on('one', () => calls.push('one'));
            socket.on('two', () => calls.push('two'));

            socket.off();
            ws.receive([MESSAGE_TYPES.MESSAGE, 1, 'one', []]);
            ws.receive([MESSAGE_TYPES.MESSAGE, 2, 'two', []]);
            await wait(20);

            assert.deepStrictEqual(calls, []);
        });

        it('ignores off() for an unknown event', () => {
            const { socket } = make();
            assert.doesNotThrow(() => socket.off('never-installed'));
        });

        it('accepts event names that are inherited from Object.prototype', async () => {
            const { ws, socket } = make();
            const calls = [];

            for (const name of ['toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
                assert.doesNotThrow(() => socket.on(name, () => calls.push(name)), `on("${name}") must work`);
            }

            for (const name of ['toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
                ws.receive([MESSAGE_TYPES.MESSAGE, 1, name, []]);
            }
            await wait(50);

            assert.deepStrictEqual(calls.sort(), ['constructor', 'hasOwnProperty', 'toString', 'valueOf']);
        });

        it('removes event names that are inherited from Object.prototype again', async () => {
            const { ws, socket } = make();
            const calls = [];
            socket.on('toString', () => calls.push('toString'));

            socket.off('toString');
            ws.receive([MESSAGE_TYPES.MESSAGE, 1, 'toString', []]);
            await wait(50);

            assert.deepStrictEqual(calls, []);
        });
    });

    describe('Wildcard handler', () => {
        it('receives the event name as first argument', async () => {
            const { ws, socket } = make();
            const calls = [];
            socket.on('*', (...args) => calls.push(args));

            ws.receive([MESSAGE_TYPES.MESSAGE, 1, 'somethingElse', ['a', 'b']]);
            await wait(20);

            assert.deepStrictEqual(calls, [['somethingElse', 'a', 'b']]);
        });

        it('receives only the event name if the message has no arguments', async () => {
            const { ws, socket } = make();
            const calls = [];
            socket.on('*', (...args) => calls.push(args));

            ws.receive([MESSAGE_TYPES.MESSAGE, 1, 'somethingElse']);
            await wait(20);

            assert.deepStrictEqual(calls, [['somethingElse']]);
        });

        it('is called additionally to the handler of the event', async () => {
            const { ws, socket } = make();
            const calls = [];
            socket.on('event', () => calls.push('named'));
            socket.on('*', name => calls.push(`wildcard:${name}`));

            ws.receive([MESSAGE_TYPES.MESSAGE, 1, 'event', []]);
            await wait(20);

            assert.deepStrictEqual(calls.sort(), ['named', 'wildcard:event']);
        });

        it('does not change the arguments of the named handler', async () => {
            const { ws, socket } = make();
            const named = [];
            socket.on('event', (...args) => named.push(args));
            socket.on('*', () => {});

            ws.receive([MESSAGE_TYPES.MESSAGE, 1, 'event', ['only']]);
            await wait(20);

            assert.deepStrictEqual(named, [['only']]);
        });

        it('gets the event name and the callback for a request', async () => {
            const { ws, socket } = make();
            const calls = [];
            socket.on('*', (...args) => {
                calls.push(args.slice(0, -1));
                args[args.length - 1](null, 'wildcard answer');
            });

            ws.receive([MESSAGE_TYPES.CALLBACK, 77, 'ask', ['question']]);
            await wait(20);

            assert.deepStrictEqual(calls, [['ask', 'question']]);
            assert.deepStrictEqual(ws.sent, [[MESSAGE_TYPES.CALLBACK, 77, 'ask', [null, 'wildcard answer']]]);
        });

        it('gets only the event name and the callback for a request without arguments', async () => {
            const { ws, socket } = make();
            const calls = [];
            socket.on('*', (name, cb) => {
                calls.push(name);
                cb(null, 'ok');
            });

            ws.receive([MESSAGE_TYPES.CALLBACK, 78, 'ask', []]);
            await wait(20);

            assert.deepStrictEqual(calls, ['ask']);
            assert.deepStrictEqual(ws.sent, [[MESSAGE_TYPES.CALLBACK, 78, 'ask', [null, 'ok']]]);
        });
    });

    describe('Answers with a callback', () => {
        it('answers with the id of the request', async () => {
            const { ws, socket } = make();
            socket.on('ask', cb => cb(null, 'answer'));

            ws.receive([MESSAGE_TYPES.CALLBACK, 4711, 'ask', []]);
            await wait(20);

            assert.deepStrictEqual(ws.sent, [[MESSAGE_TYPES.CALLBACK, 4711, 'ask', [null, 'answer']]]);
        });

        it('sends no argument array for an answer without arguments', async () => {
            const { ws, socket } = make();
            socket.on('ask', cb => cb());

            ws.receive([MESSAGE_TYPES.CALLBACK, 1, 'ask', []]);
            await wait(20);

            assert.deepStrictEqual(ws.sent, [[MESSAGE_TYPES.CALLBACK, 1, 'ask']]);
        });

        it('converts an Error in the first argument into its string', async () => {
            const { ws, socket } = make();
            socket.on('ask', cb => cb(new Error('bad')));

            ws.receive([MESSAGE_TYPES.CALLBACK, 1, 'ask', []]);
            await wait(20);

            assert.deepStrictEqual(ws.sent, [[MESSAGE_TYPES.CALLBACK, 1, 'ask', ['Error: bad']]]);
        });

        it('swallows an error of the underlying socket while answering', async () => {
            const { ws, socket } = make();
            socket.on('ask', cb => {
                ws.failSend = true;
                assert.doesNotThrow(() => cb(null, 'answer'));
            });

            ws.receive([MESSAGE_TYPES.CALLBACK, 1, 'ask', []]);
            await wait(20);
        });

        it('can answer more than once', async () => {
            const { ws, socket } = make();
            socket.on('ask', cb => {
                cb(null, 'first');
                cb(null, 'second');
            });

            ws.receive([MESSAGE_TYPES.CALLBACK, 5, 'ask', []]);
            await wait(20);

            assert.deepStrictEqual(ws.sent, [
                [MESSAGE_TYPES.CALLBACK, 5, 'ask', [null, 'first']],
                [MESSAGE_TYPES.CALLBACK, 5, 'ask', [null, 'second']],
            ]);
        });

        it('does not change the message id of emit()', async () => {
            const { ws, socket } = make();
            socket.on('ask', cb => cb(null, 'answer'));

            ws.receive([MESSAGE_TYPES.CALLBACK, 900, 'ask', []]);
            await wait(20);
            socket.emit('push');

            assert.deepStrictEqual(ws.sent[1], [MESSAGE_TYPES.MESSAGE, 1, 'push']);
        });
    });

    describe('Ping / Pong', () => {
        it('answers a ping with a pong', () => {
            const { ws, socket } = make();
            socket.on('anything', () => {});

            ws.receive([MESSAGE_TYPES.PING]);

            assert.deepStrictEqual(ws.sent, [[MESSAGE_TYPES.PONG]]);
        });

        it('does not answer a pong', () => {
            const { ws } = make();
            ws.receive([MESSAGE_TYPES.PONG]);

            assert.deepStrictEqual(ws.sent, []);
        });
    });

    describe('Invalid frames', () => {
        it('reports a frame that is not a string', async () => {
            const { ws } = make();
            const captured = await captureConsole(() => ws.receiveRaw(Buffer.from('[0,1,"x"]')));

            assert.strictEqual(captured.error.length, 1);
            assert.match(captured.error[0], /Received invalid event/);
        });

        it('reports a frame that is not valid JSON', async () => {
            const { ws } = make();
            const captured = await captureConsole(() => ws.receiveRaw('<html>'));

            assert.strictEqual(captured.error.length, 1);
            assert.match(captured.error[0], /Received invalid event/);
        });

        it('reports an undefined frame', async () => {
            const { ws } = make();
            const captured = await captureConsole(() => ws.receiveRaw(undefined));

            assert.strictEqual(captured.error.length, 1);
        });

        it('reports an unknown message type', async () => {
            const { ws } = make();
            const captured = await captureConsole(() => ws.receive([42, 1, 'x', []]));

            assert.ok(captured.log.some(line => line.includes('Received unknown event type: 42')));
        });
    });

    describe('close', () => {
        it('calls the disconnect handlers', () => {
            const { socket } = make();
            const calls = [];
            socket.on('disconnect', () => calls.push('first'));
            socket.on('disconnect', () => calls.push('second'));

            socket.close();

            assert.deepStrictEqual(calls, ['first', 'second']);
        });

        it('binds `this` of the disconnect handler to the socket', () => {
            const { socket } = make();
            let self = null;
            socket.on('disconnect', function () {
                self = this;
            });

            socket.close();

            assert.strictEqual(self, socket);
        });

        it('closes the underlying web socket', () => {
            const { ws, socket } = make();
            socket.close();

            assert.strictEqual(ws.closeCalls, 1);
        });

        it('removes all handlers', async () => {
            const { ws, socket } = make();
            const calls = [];
            socket.on('event', () => calls.push('event'));

            socket.close();
            ws.receive([MESSAGE_TYPES.MESSAGE, 1, 'event', []]);
            await wait(20);

            assert.deepStrictEqual(calls, []);
        });

        it('swallows an error of the underlying socket', () => {
            const { ws, socket } = make();
            ws.failClose = true;

            assert.doesNotThrow(() => socket.close());
        });

        it('calls the disconnect handler only once even after several calls', () => {
            const { socket } = make();
            let calls = 0;
            socket.on('disconnect', () => calls++);

            socket.close();
            socket.close();

            assert.strictEqual(calls, 1);
        });

        it('disconnect() behaves like close()', () => {
            const { ws, socket } = make();
            let called = false;
            socket.on('disconnect', () => (called = true));

            socket.disconnect();

            assert.strictEqual(called, true);
            assert.strictEqual(ws.closeCalls, 1);
        });
    });

    describe('enableCustomHandler', () => {
        it('rejects on()', () => {
            const { socket } = make();
            socket.enableCustomHandler();

            assert.throws(() => socket.on('event', () => {}), /Cannot use on\(\) with custom handler/);
        });

        it('rejects off()', () => {
            const { socket } = make();
            socket.enableCustomHandler();

            assert.throws(() => socket.off('event'), /Cannot use off\(\) with custom handler/);
        });

        it('rejects emit()', () => {
            const { socket } = make();
            socket.enableCustomHandler();

            assert.throws(() => socket.emit('event'), /Cannot use emit\(\) with custom handler/);
        });

        it('removes all previously installed handlers', async () => {
            const { ws, socket } = make();
            const calls = [];
            socket.on('event', () => calls.push('event'));

            socket.enableCustomHandler();
            ws.receive([MESSAGE_TYPES.MESSAGE, 1, 'event', []]);
            await wait(20);

            assert.deepStrictEqual(calls, []);
        });

        it('does not process incoming frames any more', async () => {
            const { ws, socket } = make();
            socket.enableCustomHandler();

            ws.receive([MESSAGE_TYPES.PING]);
            await wait(20);

            assert.deepStrictEqual(ws.sent, [], 'Not even a ping may be answered');
        });

        it('does not report invalid frames any more', async () => {
            const { ws, socket } = make();
            socket.enableCustomHandler();

            const captured = await captureConsole(() => ws.receiveRaw('no json'));
            assert.deepStrictEqual(captured.error, []);
        });

        it('calls onCloseForced when the socket is closed', () => {
            const { socket } = make();
            let called = 0;
            socket.enableCustomHandler(() => called++);

            socket.close();

            assert.strictEqual(called, 1);
        });

        it('works without onCloseForced', () => {
            const { ws, socket } = make();
            socket.enableCustomHandler();

            assert.doesNotThrow(() => socket.close());
            assert.strictEqual(ws.closeCalls, 1);
        });

        it('keeps the first onCloseForced if it is enabled twice', () => {
            const { socket } = make();
            const calls = [];
            socket.enableCustomHandler(() => calls.push('first'));
            socket.enableCustomHandler(() => calls.push('second'));

            socket.close();

            assert.deepStrictEqual(calls, ['first'], 'The second call must not replace the handler');
        });

        it('stops the keep alive timer', async () => {
            const { ws, socket } = make();
            socket.enableCustomHandler();

            // The server would send a ping after ~5 s without traffic
            await wait(5500);

            assert.deepStrictEqual(ws.sent, []);
        }).timeout(10000);
    });
});
