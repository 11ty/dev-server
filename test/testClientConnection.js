import test from "ava";
import http from "node:http";
import DevServer from "../server.js";
import { parseClientMessage, isHostnameAllowed, isConnectionAllowed, normalizePath, getReloadForPage, EventStreamClient } from "../server/clientConnection.js";
import { ReloadClient } from "../client/reload-client.js";
import { openEventStream } from "./helpers/eventStream.js";

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

function getServer(serverThread, options = {}) {
  let server = new DevServer("test-server", "./test/stubs/", {
    ...options,
    serverThread,
    portReassignmentRetryCount: 100,
    logger: { info() {}, log() {}, error() {} },
  });
  server.serve(0);
  return server;
}

function eventsUrl(port, query = "") {
  return `http://localhost:${port}/.ba/events${query}`;
}

// Opens a stream for `page` and waits for its connection status.
async function connectPage(port, page) {
  let stream = await openEventStream(eventsUrl(port, `?page=${encodeURIComponent(page)}`));
  stream.status = await stream.next("eleventy.status");
  return stream;
}

// Plain `http.request`, since `fetch` won’t set `Host` and stream responses never end.
function request(port, { method = "GET", path = "/.ba/events", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    let req = http.request({ port, method, path, headers }, (res) => {
      if(res.headers["content-type"] === "text/event-stream") {
        res.destroy();
        resolve({ statusCode: res.statusCode });
        return;
      }
      let chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function post(port, clientId, body, headers = {}) {
  return request(port, {
    method: "POST",
    path: `/.ba/events?clientId=${clientId}`,
    headers: { "Content-Type": "application/json", Origin: `http://localhost:${port}`, ...headers },
    body,
  });
}

test("normalizePath matches the client", (t) => {
  for(let path of ["/", "/index.html", "/about", "/about/", "/about/index.html", "/caf%C3%A9/", "/café/", "/about.html"]) {
    t.is(normalizePath(path), ReloadClient.normalizePath(path));
  }
});

test("getReloadForPage keeps only this page’s templates", (t) => {
  let obj = {
    type: "eleventy.reload",
    files: ["./about.njk"],
    buildId: "b1",
    build: {
      outputs: true,
      stylesheets: ["/style.css"],
      passthrough: [],
      redirects: [],
      templates: [
        { url: "/", content: "Home" },
        { url: "/about/", content: "About" },
        { url: false, content: "No permalink" },
      ],
    },
  };

  let about = getReloadForPage(obj, "/about");
  t.deepEqual(about.build.templates, [{ url: "/about/", content: "About" }]);
  t.deepEqual({ ...about.build, templates: undefined }, { ...obj.build, templates: undefined });
  t.is(about.files, obj.files);
  t.is(about.buildId, "b1");

  t.deepEqual(getReloadForPage(obj, "/missing").build.templates, []);
  t.deepEqual(getReloadForPage(obj, undefined).build.templates, []);
  t.is(obj.build.templates.length, 3);
});

test("EventStreamClient drops a client that stopped reading", (t) => {
  let writes = [];
  let destroyed = false;
  let res = {
    writableLength: 0,
    writableEnded: false,
    write: (chunk) => writes.push(chunk),
    destroy: () => destroyed = true,
  };
  let client = new EventStreamClient(res);

  client.send(`{"a":1}`, "b1");
  t.deepEqual(writes, [`id: b1\ndata: {"a":1}\n\n`]);

  res.writableLength = 3 * 1024 * 1024;
  client.send(`{"a":2}`);
  t.is(writes.length, 1);
  t.true(destroyed);
});

for(let serverThread of [true, false]) {
  let mode = serverThread ? "threaded" : "single-threaded";

  test(`Live reload refuses connections from other origins (${mode})`, async (t) => {
    let server = getServer(serverThread);
    let port = await server.getPort();

    let other = await request(port, { headers: { Origin: "https://evil.example" } });
    t.is(other.statusCode, 403);

    let rebound = await request(port, { headers: { Origin: `http://evil.example:${port}`, Host: `evil.example:${port}` } });
    t.is(rebound.statusCode, 403);

    let same = await request(port, { headers: { Origin: `http://localhost:${port}` } });
    t.is(same.statusCode, 200);

    await server.close();
  });

  test(`Live reload rejects messages that aren't JSON objects from this site (${mode})`, async (t) => {
    let received = [];
    let server = getServer(serverThread, { onClientMessage: (message) => received.push(message) });
    let port = await server.getPort();

    let stream = await connectPage(port, "/");
    let { clientId } = stream.status;

    for(let body of ["NOT-VALID-JSON{{{", "null", "1", "[]"]) {
      t.is((await post(port, clientId, body)).statusCode, 400);
    }
    t.is((await post(port, clientId, "{}", { "Content-Type": "text/plain" })).statusCode, 415);
    t.is((await post(port, clientId, "{}", { Origin: "https://evil.example" })).statusCode, 403);
    t.is((await post(port, "missing", "{}")).statusCode, 404);
    t.is((await post(port, clientId, `{"id":"${"x".repeat(2 * 1024 * 1024)}"}`)).statusCode, 413);
    t.is((await request(port, { method: "PUT" })).statusCode, 405);

    let ack = await post(port, clientId, JSON.stringify({ id: "after" }));
    t.is(ack.statusCode, 200);
    t.deepEqual(JSON.parse(ack.body), { type: "eleventy.ack", id: "after" });

    await new Promise((resolve) => setTimeout(resolve, 50));
    t.deepEqual(received.map(({ id }) => id), ["after"]);

    stream.close();
    await server.close();
  });

  test(`Reloads with build.outputs only send each tab its own templates (${mode})`, async (t) => {
    let server = getServer(serverThread);
    let port = await server.getPort();

    let home = await connectPage(port, "/index.html");
    let about = await connectPage(port, "/about");
    let other = await connectPage(port, "/other/");

    let reloads = Promise.all([home, about, other].map(stream => stream.next("eleventy.reload")));
    server.reload({
      files: ["./_data/site.json"],
      build: {
        outputs: true,
        stylesheets: [],
        passthrough: [],
        templates: [
          { url: "/", inputPath: "./index.njk", content: "Home" },
          { url: "/about/", inputPath: "./about.njk", content: "About" },
        ],
      },
    });

    let [homeReload, aboutReload, otherReload] = await reloads;
    t.deepEqual(homeReload.build.templates.map(({ content }) => content), ["Home"]);
    t.deepEqual(aboutReload.build.templates.map(({ content }) => content), ["About"]);
    t.deepEqual(otherReload.build.templates, []);
    t.deepEqual(otherReload.files, ["./_data/site.json"]);
    t.true(otherReload.build.outputs);
    t.is(otherReload.buildId, homeReload.buildId);
    t.is(homeReload.eventId, homeReload.buildId);

    for(let stream of [home, about, other]) {
      stream.close();
    }
    await server.close();
  });

  test(`Reloads without build.outputs are broadcast unchanged (${mode})`, async (t) => {
    let server = getServer(serverThread);
    let port = await server.getPort();

    let home = await connectPage(port, "/");
    let about = await connectPage(port, "/about/");

    let reloads = Promise.all([home, about].map(stream => stream.next("eleventy.reload")));
    server.reload({
      files: ["./index.njk", "./about.njk"],
      build: {
        templates: [
          { url: "/", inputPath: "./index.njk", content: "Home" },
          { url: "/about/", inputPath: "./about.njk", content: "About" },
        ],
      },
    });

    for(let reload of await reloads) {
      t.deepEqual(reload.build.templates.map(({ url }) => url), ["/", "/about/"]);
      t.is(reload.eventId, reload.buildId);
    }

    home.close();
    about.close();
    await server.close();
  });

  test(`Client messages carry a clientId for targeted replies (${mode})`, async (t) => {
    let received;
    let clientMessage = new Promise((resolve) => { received = resolve; });
    let server = getServer(serverThread, { onClientMessage: (message) => received(message) });
    let port = await server.getPort();

    let sender = await connectPage(port, "/");
    let bystander = await connectPage(port, "/");
    t.not(sender.status.clientId, bystander.status.clientId);

    let ack = await post(port, sender.status.clientId, JSON.stringify({ id: "m1", type: "hello", data: {}, timestamp: Date.now() }));
    t.is(JSON.parse(ack.body).id, "m1");

    let message = await clientMessage;
    t.is(message.type, "hello");
    t.is(message.clientId, sender.status.clientId);

    let senderReply = sender.next("eleventy.msg");
    let bystanderMessage = bystander.next("eleventy.msg");
    server.sendUpdateNotification({ type: "eleventy.msg", message: "reply" }, { clientId: message.clientId });
    server.sendUpdateNotification({ type: "eleventy.msg", message: "everyone" });

    t.is((await senderReply).message, "reply");
    t.is((await bystanderMessage).message, "everyone");

    sender.close();
    bystander.close();
    await server.close();
  });

  test(`Closing the server ends open streams (${mode})`, async (t) => {
    let server = getServer(serverThread);
    let port = await server.getPort();

    let stream = await connectPage(port, "/");
    t.is(stream.status.eventId, stream.status.buildId);

    let rest = (async () => {
      let messages = [];
      let message;
      while((message = await stream.next())) {
        messages.push(message);
      }
      return messages;
    })();

    await server.close();
    let messages = await rest;
    t.deepEqual(messages.map(({ status }) => status), ["disconnected"]);
  });
}
