/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */
/* jshint expr: true */
'use strict';

const expect = require('chai').expect;

describe('Implement tests', () => {
    const socket = require('../index');
    const http = require('http');

    it('Test', done => {
        const requestListener = (req, res) => {
            res.writeHead(200);
            res.end('Hello, World!');
        };

        // create web server
        const webServer    = http.createServer(requestListener);
        // create web socket server
        const socketServer = socket.listen(webServer);

        // install event handlers on socket connection
        function onConnection(socket, initDone) {
            console.log(`==> Connected IP: ${socket.connection.remoteAddress}`);

            socket.on('message', (data, cb) => {
                console.log('Received ' + data);
                cb(data + 1);
            });

            socket.on('disconnect', error => {
                console.log(`<== Disconnect from ${socket.connection.remoteAddress}: ${error}`);
            });

            initDone && initDone();
        }

        // install event handlers of the socket server
        socketServer.on('connection', onConnection);
        socketServer.on('error', (e, details) =>
            console.error(`Server error: ${e}${details ? ' - ' + details : ''}`));

        // start web server
        webServer.listen(5000);

        setTimeout(() => {
            webServer.close();
            done();
        }, 3000);
    }).timeout(4000);
});
