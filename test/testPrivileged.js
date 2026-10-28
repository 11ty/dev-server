import test from "ava";
import net from "node:net";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import DevServer from "../server.js";
import { WsClient } from "../client/ws-client.js";
import { isTokenMatch, isLoopbackAddress, isPrivilegedConnectionAllowed } from "../server/privilegedChannel.js";
import { openEventStream } from "./helpers/eventStream.js";

const TOKEN = "fake-test-token-0123456789abcdefghij";

function getServer(serverThread, ws = {}) {
  let server = new DevServer("test-server", "./test/stubs/", {
    serverThread,
    portReassignmentRetryCount: 100,
    logger: { info() {}, log() {}, error() {} },
    ws: ws === false ? false : { token: TOKEN, ...ws },
  });
  server.serve(0);
  return server;
}

function getFreePort() {
  return new Promise((resolve) => {
    let server = net.createServer().listen(0, "127.0.0.1", () => {
      let { port } = /** @type {net.AddressInfo} */ (server.address());
      server.close(() => resolve(port));
    });
  });
}

// Resolves with the open socket, or `opened: false` and the refusal’s status code.
function connect(url, origin) {
  return new Promise((resolve) => {
    let ws = new WebSocket(url, origin ? { origin } : {});
    ws.once("open", () => resolve({ ws, opened: true }));
    ws.once("unexpected-response", (req, res) => {
      req.destroy();
      resolve({ opened: false, statusCode: res.statusCode });
    });
    ws.once("error", () => resolve({ opened: false }));
  });
}

function nextMessage(ws, match) {
  return new Promise((resolve) => {
    let onMessage = (data) => {
      let message = JSON.parse(data.toString());
      if(match(message)) {
        ws.off("message", onMessage);
        resolve(message);
      }
    };
    ws.on("message", onMessage);
  });
}

function nextClose(ws) {
  return new Promise((resolve) => ws.once("close", (code) => resolve(code)));
}

async function authenticate(port, { sessionId = randomUUID(), host = `localhost:${port}` } = {}) {
  let { ws } = await connect(`ws://${host}/.ba/ws`, `http://${host}`);
  let authed = nextMessage(ws, ({ type }) => type === "buildawesome.auth");
  ws.send(JSON.stringify({ type: "auth", token: TOKEN, sessionId }));
  await authed;
  return ws;
}

function send(ws, id, type, data) {
  let reply = nextMessage(ws, (message) => message.type === "buildawesome.reply" && message.id === id);
  ws.send(JSON.stringify({ id, type, data }));
  return reply;
}

test("isTokenMatch", (t) => {
  t.true(isTokenMatch(TOKEN, TOKEN));
  t.false(isTokenMatch(TOKEN, `${TOKEN}x`));
  t.false(isTokenMatch(TOKEN, undefined));
});

test("isLoopbackAddress", (t) => {
  t.true(isLoopbackAddress("127.0.0.1"));
  t.true(isLoopbackAddress("::1"));
  t.true(isLoopbackAddress("::ffff:127.0.0.1"));
  t.false(isLoopbackAddress("192.168.1.20"));
  t.false(isLoopbackAddress(undefined));
});

test("isPrivilegedConnectionAllowed requires this exact origin from this machine", (t) => {
  let remoteAddress = "127.0.0.1";
  t.true(isPrivilegedConnectionAllowed({ origin: "http://localhost:8080", host: "localhost:8080", remoteAddress }));
  t.false(isPrivilegedConnectionAllowed({ origin: "http://localhost:3000", host: "localhost:8080", remoteAddress }), "other ports are other origins");
  t.false(isPrivilegedConnectionAllowed({ host: "localhost:8080", remoteAddress }), "Origin is required");
  t.false(isPrivilegedConnectionAllowed({ origin: "http://evil.example:8080", host: "evil.example:8080", remoteAddress }));
  t.false(isPrivilegedConnectionAllowed({ origin: "http://192.168.1.20:8080", host: "192.168.1.20:8080", remoteAddress: "192.168.1.30" }));
});

test("The ws option needs a long token, and a port without sameOrigin", (t) => {
  let options = { logger: { info() {}, log() {}, error() {} } };
  t.throws(() => new DevServer("test-server", "./test/stubs/", { ...options, ws: { token: "short" } }), { message: /at least 32 characters/ });
  t.throws(() => new DevServer("test-server", "./test/stubs/", { ...options, ws: { token: TOKEN, sameOrigin: false } }), { message: /ws\.port/ });
});

for(let serverThread of [true, false]) {
  let mode = serverThread ? "threaded" : "single-threaded";

  test(`Without the ws option there is no privileged socket or client (${mode})`, async (t) => {
    let server = getServer(serverThread, false);
    let port = await server.getPort();

    let { opened } = await connect(`ws://localhost:${port}/.ba/ws`, `http://localhost:${port}`);
    t.false(opened);
    t.is((await fetch(`http://localhost:${port}/.ba/ws-client.js`)).status, 404);

    await server.close();
  });

  test(`Privileged sockets refuse other origins and bad tokens (${mode})`, async (t) => {
    let server = getServer(serverThread);
    let port = await server.getPort();
    let url = `ws://localhost:${port}/.ba/ws`;

    t.is((await connect(url, "https://evil.example")).statusCode, 403);
    t.is((await connect(url, "http://localhost:3000")).statusCode, 403);
    t.is((await connect(url)).statusCode, 403);
    t.false((await connect(`ws://localhost:${port}/elsewhere`, `http://localhost:${port}`)).opened);

    let wrongToken = (await connect(url, `http://localhost:${port}`)).ws;
    let wrongTokenClosed = nextClose(wrongToken);
    wrongToken.send(JSON.stringify({ type: "auth", token: `${TOKEN}x`, sessionId: "s" }));
    t.is(await wrongTokenClosed, 4401);

    let noAuth = (await connect(url, `http://localhost:${port}`)).ws;
    let noAuthClosed = nextClose(noAuth);
    noAuth.send(JSON.stringify({ id: "m1", type: "write" }));
    t.is(await noAuthClosed, 4401);

    t.is((await fetch(`http://localhost:${port}/.ba/ws-client.js`)).status, 200);

    await server.close();
  });

  test(`Privileged replies come from onMessage’s result or error (${mode})`, async (t) => {
    let server = getServer(serverThread, {
      onMessage(message) {
        if(message.type === "fail") {
          throw new Error("Nope");
        }
        return { echo: message.data, clientId: message.clientId };
      },
    });
    let port = await server.getPort();
    let sessionId = randomUUID();
    let ws = await authenticate(port, { sessionId });

    let ok = await send(ws, "m1", "echo", { a: 1 });
    t.true(ok.ok);
    t.deepEqual(ok.data, { echo: { a: 1 }, clientId: sessionId });

    let failed = await send(ws, "m2", "fail");
    t.false(failed.ok);
    t.is(failed.error.message, "Nope");

    ws.close();
    await server.close();
  });

  test(`A resent message id gets the cached reply without running again (${mode})`, async (t) => {
    let calls = 0;
    let server = getServer(serverThread, { onMessage: () => ++calls });
    let port = await server.getPort();
    let sessionId = randomUUID();

    let first = await authenticate(port, { sessionId });
    t.is((await send(first, "m1", "write")).data, 1);
    first.close();

    let second = await authenticate(port, { sessionId });
    t.is((await send(second, "m1", "write")).data, 1);
    t.is((await send(second, "m2", "write")).data, 2);
    t.is(calls, 2);

    // Another session runs its own copy
    let other = await authenticate(port);
    t.is((await send(other, "m1", "write")).data, 3);

    second.close();
    other.close();
    await server.close();
  });

  test(`Privileged pushes reach only privileged sockets (${mode})`, async (t) => {
    let server = getServer(serverThread, {
      onMessage(message, client) {
        client.send({ type: "buildawesome.saved", path: message.data });
      },
    });
    let port = await server.getPort();

    let stream = await openEventStream(`http://localhost:${port}/.ba/events`);
    await stream.next("eleventy.status");
    let ws = await authenticate(port);
    let bystander = await authenticate(port);

    let pushed = nextMessage(ws, ({ type }) => type === "buildawesome.secret");
    server.sendUpdateNotification({ type: "buildawesome.secret" }, { privileged: true });
    server.sendUpdateNotification({ type: "eleventy.msg", message: "public" });
    await pushed;
    t.is((await stream.next()).message, "public");

    let bystanderMessages = [];
    bystander.on("message", (data) => bystanderMessages.push(JSON.parse(data.toString()).type));
    let saved = nextMessage(ws, ({ type }) => type === "buildawesome.saved");
    await send(ws, "m1", "write", "/index.html");
    t.is((await saved).path, "/index.html");
    t.false(bystanderMessages.includes("buildawesome.saved"));

    ws.close();
    bystander.close();
    stream.close();
    await server.close();
  });
}

test("With sameOrigin: false, privileged clients use their own loopback port", async (t) => {
  let wsPort = await getFreePort();
  let server = getServer(true, { sameOrigin: false, port: wsPort, dir: "./test/stubs/", onMessage: () => "ok" });
  let port = await server.getPort();

  let client;
  let deadline = Date.now() + 2000;
  while(!client?.ok && Date.now() < deadline) {
    client = await fetch(`http://localhost:${wsPort}/.ba/ws-client.js`).catch(() => undefined);
  }
  t.is(client?.status, 200);

  let page = await fetch(`http://localhost:${wsPort}/sample.html`);
  t.is(page.status, 200);
  t.false((await page.text()).includes("reload-client.js"));

  let ws = await authenticate(wsPort);
  t.is((await send(ws, "m1", "write")).data, "ok");

  // Not on the main server, and the main server’s origin isn’t this one
  t.false((await connect(`ws://localhost:${port}/.ba/ws`, `http://localhost:${port}`)).opened);
  t.is((await connect(`ws://localhost:${wsPort}/.ba/ws`, `http://localhost:${port}`)).statusCode, 403);

  ws.close();
  await server.close();
});

// Node’s `WebSocket` sends no Origin, so tests swap in `ws` with one.
async function withWsClient(port, fn) {
  let previous = globalThis.WebSocket;
  globalThis.WebSocket = /** @type {any} */ (class extends WebSocket {
    constructor(url) {
      super(url, { origin: `http://localhost:${port}` });
    }
  });
  try {
    return await fn(`ws://localhost:${port}/.ba/ws`);
  } finally {
    globalThis.WebSocket = previous;
  }
}

test.serial("WsClient sends, receives pushes, and stops after a bad token", async (t) => {
  let server = getServer(true, {
    onMessage(message, client) {
      client.send({ type: "buildawesome.saved", path: message.data.path });
      return { saved: true, clientId: message.clientId };
    },
  });
  let port = await server.getPort();

  await withWsClient(port, async (url) => {
    let client = new WsClient({ token: TOKEN, url });
    let saved = new Promise((resolve) => client.addEventListener("buildawesome.saved", (event) => resolve(event.detail)));

    let reply = await client.send("write", { path: "/index.html" });
    t.deepEqual(reply, { saved: true, clientId: client.clientId });
    t.is((await saved).path, "/index.html");
    client.close();
    await t.throwsAsync(client.send("write", {}), { message: "Connection closed." });

    let bad = new WsClient({ token: `${TOKEN}x`, url });
    let authFailed = new Promise((resolve) => bad.addEventListener("authfailed", resolve));
    await t.throwsAsync(bad.send("write", {}), { message: "Authentication failed." });
    await authFailed;
  });

  await server.close();
});
