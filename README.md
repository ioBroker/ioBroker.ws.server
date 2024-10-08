# @iobroker/ws-server

This library is used for communication with the front-end via pure web-sockets.

It simulates `socket.io` interface.

It is used normally together with `@iobroker/ws` on the browser side, and it is not compatible with `socket.io.client` library.

## Usage

```js
const http = require('node:http');
const { SocketIO } = require('@iobroker/ws-server');

const requestListener = function (req, res) {
  res.writeHead(200);
  res.end('Hello, World!');
};

// create web server
const webServer    = http.createServer(requestListener);
// create web socket server
const socketServer = new SocketIO(webServer);

// install event handlers on socket connection
function onConnection(socket, initDone) {
    console.log('==> Connected IP: ' + socket.connection.remoteAddress);

    socket.on('customMessage', function (data, cb) {
        console.log('Received ' + data);
        cb(data + 1);
    });

    socket.on('disconnect', function (error) {
        console.log(`<== Disconnect from ${socket.connection.remoteAddress}: ${error}`);
    });

    initDone && initDone();
}

// install event handlers of the socket server
socketServer.on('connection', onConnection);
socketServer.on('error', (e, details) => console.error(`Server error: ${e}${details ? ' - ' + details : ''}`));

// start web server
webServer.listen(5000);
```

<!--
	Placeholder for the next version (at the beginning of the line):
	### **WORK IN PROGRESS**
-->

## Changelog
### 3.0.3 (2024-10-08)
   
-   (@GermanBluefox) Corrected error with session ID and authentication

### 3.0.0 (2024-10-02)

-   (@GermanBluefox) Package was rewritten with typescript
-   BREAKING CHANGE: import of SocketIO class changed (see example above)

### 2.1.2 (2023-12-17)

-   (foxriver76) increase maximum message size from 100 MB to 500 MB

### 2.1.1 (2023-07-31)

-   (@GermanBluefox) Packages updated

### 2.1.0 (2022-05-19)

-   (@GermanBluefox) Support interface of socket.io 4.0

### 2.0.0 (2022-04-24)

-   (@GermanBluefox) renamed package into `@iobroker/ws-server`
-   (@GermanBluefox) added error handlers

### 1.0.1 (2022-01-30)

-   (@GermanBluefox) initial commit

## License

The MIT License (MIT)

Copyright (c) 2020-2024 Bluefox <dogafox@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
