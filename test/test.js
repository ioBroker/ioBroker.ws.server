const { readFileSync } = require('node:fs');
const puppeteer = require('puppeteer');

describe('Communication test', () => {
    const { SocketIO } = require('../dist');
    const http = require('node:http');

    it('Test', done => {
        const requestListener = (req, res) => {
            if (req.url === '/socket.io.js.map') {
                res.writeHead(200);
                res.end(readFileSync(`${__dirname}/../node_modules/@iobroker/ws/dist/esm/socket.io.js.map`));
                return;
            } else if (req.url === '/socket.io.js') {
                res.writeHead(200);
                res.end(readFileSync(`${__dirname}/../node_modules/@iobroker/ws/dist/esm/socket.io.js`));
                return;
            } else if (req.url === '/' || req.url === '/index.html') {
                res.writeHead(200);
                res.end(readFileSync(`${__dirname}/public/index.html`));
                return;
            }
            res.writeHead(200);
            res.end('Hello, World!');
        };

        // create web server
        const webServer = http.createServer(requestListener);
        // create web socket server
        const socketServer = new SocketIO(webServer);

        // install event handlers on socket connection
        function onConnection(socket, initDone) {
            console.log(`==> Connected IP: ${socket.connection.remoteAddress}`);

            socket.on('data', (data, cb) => {
                console.log(`Received ${data}`);
                cb(null, data + 1);
            });

            socket.on('terminate', () => {
                console.log(`Received termination signal`);
                webServer.close();
                done();
            });

            socket.on('disconnect', error => {
                console.log(`<== Disconnect from ${socket.connection.remoteAddress}: ${error}`);
            });

            initDone && initDone();
        }

        // install event handlers of the socket server
        socketServer.on('connection', onConnection);
        socketServer.on('error', (e, details) => console.error(`Server error: ${e}${details ? ` - ${details}` : ''}`));

        // start web server
        webServer.listen(5000, async () => {
            console.log('Server started on port 5000');
            const browser = await puppeteer.launch({ headless: true });
            const [page] = await browser.pages();
            await page.goto('http://localhost:5000');
        });
    }).timeout(40000);
});
