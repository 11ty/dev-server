import test from "ava";
import WebSocket from "ws";
import DevServer from "../server.js";
import { parseClientMessage, isHostnameAllowed, isConnectionAllowed } from "../server/clientConnection.js";

test("parseClientMessage only returns JSON objects", (t) => {
  t.deepEqual(parseClientMessage(Buffer.from(`{"id":1}`)), { id: 1 });
  t.is(parseClientMessage(Buffer.from("NOT-VALID-JSON{{{")), undefined);
  t.is(parseClientMessage(Buffer.from("null")), undefined);
  t.is(parseClientMessage(Buffer.from("1")), undefined);
  t.is(parseClientMessage(Buffer.from(`"string"`)), undefined);
  t.is(parseClientMessage(Buffer.from("[]")), undefined);
});

test("isHostnameAllowed", (t) => {
  t.true(isHostnameAllowed("localhost"));
  t.true(isHostnameAllowed("site.localhost"));
  t.true(isHostnameAllowed("127.0.0.1"));
  t.true(isHostnameAllowed("192.168.1.20"));
  t.true(isHostnameAllowed("::1"));
  t.false(isHostnameAllowed("evil.example"));
  t.false(isHostnameAllowed(undefined));

  t.true(isHostnameAllowed("mysite.test", ["mysite.test"]));
  t.false(isHostnameAllowed("www.mysite.test", ["mysite.test"]));
  t.true(isHostnameAllowed("www.mysite.test", [".mysite.test"]));
  t.true(isHostnameAllowed("mysite.test", [".mysite.test"]));
  t.false(isHostnameAllowed("notmysite.test", [".mysite.test"]));
  t.true(isHostnameAllowed("anything.example", true));
});

test("isConnectionAllowed", (t) => {
  t.true(isConnectionAllowed({ origin: "http://localhost:8080", host: "localhost:8080" }));
  t.true(isConnectionAllowed({ origin: "http://[::1]:8080", host: "[::1]:8080" }));
  t.true(isConnectionAllowed({ host: "localhost:8080" }), "non-browser clients send no Origin");

  // Other sites
  t.false(isConnectionAllowed({ origin: "https://evil.example", host: "localhost:8080" }));
  t.false(isConnectionAllowed({ origin: "null", host: "localhost:8080" }));

  // DNS rebinding: same origin, but a domain name that isn't allowed
  t.false(isConnectionAllowed({ origin: "http://evil.example:8080", host: "evil.example:8080" }));
  t.true(isConnectionAllowed({ origin: "http://mysite.test", host: "mysite.test" }, ["mysite.test"]));

  // `true` skips the Host check, but not the Origin check
  t.true(isConnectionAllowed({ origin: "http://evil.example", host: "evil.example" }, true));
  t.false(isConnectionAllowed({ origin: "https://evil.example", host: "localhost:8080" }, true));
});

function getServer(serverThread) {
  let server = new DevServer("test-server", "./test/stubs/", {
    serverThread,
    portReassignmentRetryCount: 100,
    logger: { info() {}, log() {}, error() {} },
  });
  server.serve(0);
  return server;
}

function connect(port, options) {
  return new Promise((resolve) => {
    let ws = new WebSocket(`ws://localhost:${port}`, options);
    ws.once("open", () => resolve({ ws, opened: true }));
    ws.once("error", () => resolve({ ws, opened: false }));
  });
}

for(let serverThread of [true, false]) {
  let mode = serverThread ? "threaded" : "single-threaded";

  test(`Live reload refuses connections from other origins (${mode})`, async (t) => {
    let server = getServer(serverThread);
    let port = await server.getPort();

    let other = await connect(port, { origin: "https://evil.example" });
    t.false(other.opened);

    let rebound = await connect(port, { origin: `http://evil.example:${port}`, headers: { Host: `evil.example:${port}` } });
    t.false(rebound.opened);

    let same = await connect(port, { origin: `http://localhost:${port}` });
    t.true(same.opened);
    same.ws.close();

    await server.close();
  });

  test(`Live reload survives messages that aren't JSON objects (${mode})`, async (t) => {
    let server = getServer(serverThread);
    let port = await server.getPort();

    let { ws } = await connect(port, { origin: `http://localhost:${port}` });
    for(let message of ["NOT-VALID-JSON{{{", "null", "1", "[]"]) {
      ws.send(message);
    }
    ws.send(JSON.stringify({ id: "after" }));

    let ack = await new Promise((resolve) => {
      ws.on("message", (data) => {
        let message = JSON.parse(data.toString());
        if(message.type === "eleventy.ack") {
          resolve(message);
        }
      });
    });

    t.is(ack.id, "after");
    ws.close();
    await server.close();
  });
}
