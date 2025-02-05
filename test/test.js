const { readFileSync } = require('node:fs');
const puppeteer = require('puppeteer');

describe('Communication test', () => {
    const { SocketIO } = require('../dist');
    const http = require('node:http');

    it('Test', done => {
        const requestListener = (req, res) => {
            console.log(`${new Date().toISOString()} [SERVER] request by web server "${req.url}`);

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
            } else if (req.url === '/favicon.ico') {
                res.writeHead(404);
                res.end('Not found');
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
            console.log(`${new Date().toISOString()} [WSERVER] ==> Connected IP: ${socket.connection.remoteAddress}`);

            socket.on('data', (data, cb) => {
                console.log(`${new Date().toISOString()} [WSERVER] Received ${data}`);
                cb(null, data + 1);
            });

            socket.on('terminate', () => {
                console.log(`${new Date().toISOString()} [WSERVER] Received termination signal`);
                webServer.close();
                done();
            });

            socket.on('disconnect', error => {
                console.log(`${new Date().toISOString()} [WSERVER] <== Disconnect from ${socket.connection.remoteAddress}: ${error}`);
            });

            initDone && initDone();
        }

        // install event handlers of the socket server
        socketServer.on('connection', onConnection);
        socketServer.on('error', (e, details) => console.error(`${new Date().toISOString()} Server error: ${e}${details ? ` - ${details}` : ''}`));

        // start web server
        webServer.listen(5000, async () => {
            console.log(`${new Date().toISOString()} [SERVER] Server started on port 5000`);
            const browser = await puppeteer.launch({ headless: true });
            const [page] = await browser.pages();
            page.on('console', msg => console.log(`${new Date().toISOString()} [BROWSER]:`, msg.text()));

            console.log(`${new Date().toISOString()} Open http://localhost:5000`);
            await page.goto('http://localhost:5000');
            await page.waitForNavigation({ waitUntil: 'load' });
            console.log(`${new Date().toISOString()} page loaded in browser`);
        });
    }).timeout(40000);
});
