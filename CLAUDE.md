# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`@iobroker/ws-server` is a lightweight WebSocket server library that simulates a Socket.IO-like interface for ioBroker. It wraps the `ws` package and is **not compatible with socket.io.client** — it must be paired with `@iobroker/ws` on the browser side.

## Commands

- **Build:** `npm run build` (compiles TypeScript from `src/` to `build/`)
- **Lint:** `npm run lint`
- **Test:** `npm test` (runs integration tests with Mocha + Puppeteer on port 5000)
- **Run single test by pattern:** `npx mocha --grep "pattern" --exit`
- **Release:** `npm run release-patch`, `npm run release-minor`, `npm run release-major`

## Architecture

The entire library is a single TypeScript file (`src/index.ts`) exporting two classes:

- **`Socket`** — Wraps an individual WebSocket connection. Manages event handlers, ping/pong keep-alive, message serialization, and callback-based request/response. Exposes many public `_`-prefixed properties consumed by `@iobroker/socket-classes` (auth, ACL, subscriptions, sessions) and cloud integration.
- **`SocketIO`** — The server class. Takes an `http.Server`/`https.Server`, creates a `WebSocketServer`, handles client verification via middleware (`.use()`), manages the socket lifecycle, and provides Socket.IO 2.0/4.0 compatible `sockets` interface.

### Wire Protocol

Messages are JSON arrays: `[type, id, name, args?]`

| Type | Value | Purpose |
|------|-------|---------|
| MESSAGE | 0 | Regular message |
| PING | 1 | Keep-alive ping |
| PONG | 2 | Keep-alive pong |
| CALLBACK | 3 | Message expecting a response callback |

### Connection Lifecycle

1. Client connects with `?sid=<sessionId>` query parameter
2. `verifyClient` runs registered middleware; on failure, marks `_wsNotAuth` and sends `reauthenticate`
3. On success, a `Socket` is created and connection handlers are called with an `initDone` callback
4. Server emits `___ready___` to client once handlers are installed (1.5s timeout fallback)

### Key Design Notes

- Wildcard handler (`'*'`) receives all messages with the event name prepended to args
- `enableCustomHandler()` disables built-in message processing (used by cloud)
- Max payload: 500 MB (`MAX_PAYLOAD = 524_288_000`)
- Private fields use `#` syntax; public ioBroker integration fields use `_` prefix

## Testing

`npm test` runs Mocha over `test/*.js` (~2 minutes). Tests run against `build/`, so **run `npm run build` first** after changing `src/`.

| File | Scope |
|------|-------|
| `test/lib/helpers.js` | Shared helpers — not a spec file (Mocha is not recursive) |
| `test/socketApi.js` | `Socket` unit tests against a fake WebSocket (no network) |
| `test/protocol.js` | Wire protocol over a real connection, incl. malformed frames |
| `test/connection.js` | Handshake, `___ready___`, missing sid, `use()` middleware, socket properties, disconnect |
| `test/serverApi.js` | `SocketIO` class: socket lists, `clientsCount`, broadcast, `close()` |
| `test/keepAlive.js` | Ping/pong timing — needs real time (~65 s of the total runtime) |
| `test/integrationClient.js` | Integration against the real `@iobroker/ws` client, driven in Node |
| `test/socketId.js` | Socket id is generated on the server, never taken from `?sid=` |
| `test/test.js` | End-to-end via Puppeteer on port 5000, HTML client in `test/public/index.html` |

`test/lib/helpers.js` provides `createTestServer()` (HTTP + `SocketIO` on an ephemeral port, records all sockets and `error` events) and `TestClient` (a raw protocol client that can send malformed frames and await individual frames).

`@iobroker/ws` is a browser library, but it accepts the WebSocket implementation via `options.WebSocket`, which is how `test/integrationClient.js` drives it under Node.

## CI

GitHub Actions runs lint on push/PR (Node 22), and deploys to npm on semantic version tags (Node 24) using ioBroker testing actions.
