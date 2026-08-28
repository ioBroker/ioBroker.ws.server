const assert = require('node:assert');
const http = require('node:http');
const WebSocket = require('ws');

const PORT = 5001;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('Socket ID', function () {
    this.timeout(10000);

    const { SocketIO } = require('../build');

    let webServer;
    /** Sockets as seen by the server, in order of connection */
    let serverSockets;
    /** Clients created by connect(), closed after every test */
    let clients;

    beforeEach(done => {
        serverSockets = [];
        clients = [];
        webServer = http.createServer((_req, res) => {
            res.writeHead(200);
            res.end('Hello, World!');
        });
        const socketServer = new SocketIO(webServer);
        socketServer.on('connection', (socket, initDone) => {
            serverSockets.push(socket);
            initDone && initDone();
        });
        webServer.listen(PORT, done);
    });

    afterEach(done => {
        clients.forEach(ws => ws.terminate());
        webServer.closeAllConnections();
        webServer.close(() => done());
    });

    /** Connect a raw web socket and wait till the server has installed all handlers */
    function connect(sid) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?sid=${sid}`);
            clients.push(ws);
            ws.on('error', reject);
            // The server sends "___ready___" as soon as all handlers are installed
            ws.on('message', () => resolve(ws));
        });
    }

    it('The socket ID is generated on the server and not taken from the query', async () => {
        await connect('1234567890');

        assert.strictEqual(serverSockets.length, 1);
        assert.notStrictEqual(serverSockets[0].id, '1234567890', 'The client must not choose the socket ID');
        assert.match(serverSockets[0].id, UUID_PATTERN);
    });

    it('Two connections with the same sid get different socket IDs', async () => {
        await connect('1234567890');
        await connect('1234567890');

        assert.strictEqual(serverSockets.length, 2);
        assert.notStrictEqual(serverSockets[0].id, serverSockets[1].id);
    });

    it('Without a session cookie no authentication session ID is set', async () => {
        await connect('1234567890');

        assert.strictEqual(serverSockets.length, 1);
        // Must stay empty, otherwise it shadows the user/pass authentication in @iobroker/socket-classes
        assert.strictEqual(serverSockets[0].conn.request.sessionID, '');
    });
});
