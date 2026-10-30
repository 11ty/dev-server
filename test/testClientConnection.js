import fs from "node:fs";
import http from "node:http";
import test from "ava";
import WebSocket from "ws";
import DevServer from "../server.js";
import { parseClientMessage, isHostnameAllowed, isConnectionAllowed, normalizePath, getReloadForPage, PageBaselines } from "../server/clientConnection.js";
import { ReloadClient } from "../client/reload-client.js";

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

// Resolves with the next message matching `type`.
function nextMessage(ws, type) {
  return new Promise((resolve) => {
    let onMessage = (data) => {
      let message = JSON.parse(data.toString());
      if(message.type === type) {
        ws.off("message", onMessage);
        resolve(message);
      }
    };
    ws.on("message", onMessage);
  });
}

// Opens a socket for `page` and waits for its connection status.
async function connectPage(port, page) {
  let ws = new WebSocket(`ws://localhost:${port}/?page=${encodeURIComponent(page)}`, { origin: `http://localhost:${port}` });
  await nextMessage(ws, "eleventy.status");
  return ws;
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

test("PageBaselines adds the previous content to templates, then remembers the new content", (t) => {
  let baselines = new PageBaselines();
  baselines.set("/about/index.html", "Served");

  let reload = (content) => baselines.apply({
    type: "eleventy.reload",
    build: {
      outputs: true,
      templates: [
        { url: "/about/", inputPath: "./about.njk", content },
        { url: "/new/", inputPath: "./new.njk", content: "New" },
        { url: "/no-content/", inputPath: "./no-content.njk" },
      ],
    },
  });

  let first = reload("About v2").build.templates;
  t.is(first[0].previousContent, "Served");
  t.false("previousContent" in first[1]);
  t.false("previousContent" in first[2]);

  let second = reload("About v3").build.templates;
  t.is(second[0].previousContent, "About v2");
  t.is(second[1].previousContent, "New");

  let notReload = { type: "eleventy.msg", message: "Hi" };
  t.is(baselines.apply(notReload), notReload);
});

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

  test(`Reloads with build.outputs only send each tab its own templates (${mode})`, async (t) => {
    let server = getServer(serverThread);
    let port = await server.getPort();

    let home = await connectPage(port, "/index.html");
    let about = await connectPage(port, "/about");
    let other = await connectPage(port, "/other/");

    let reloads = Promise.all([home, about, other].map(ws => nextMessage(ws, "eleventy.reload")));
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

    for(let ws of [home, about, other]) {
      ws.close();
    }
    await server.close();
  });

  test(`Reloads include the HTML the page was served, then the last content sent (${mode})`, async (t) => {
    let server = getServer(serverThread);
    let port = await server.getPort();

    let served = await new Promise((resolve) => {
      http.get(`http://localhost:${port}/`, (res) => {
        let body = "";
        res.on("data", chunk => body += chunk);
        res.on("end", () => resolve(body));
      });
    });
    t.true(served.includes("reload-client.js"));

    let home = await connectPage(port, "/");
    let reload = (content) => {
      let message = nextMessage(home, "eleventy.reload");
      server.reload({
        files: ["./index.njk"],
        build: { outputs: true, templates: [{ url: "/", inputPath: "./index.njk", content }] },
      });
      return message;
    };

    let [first] = (await reload("Home v2")).build.templates;
    t.is(first.previousContent, fs.readFileSync("./test/stubs/index.html", "utf8"));

    let [second] = (await reload("Home v3")).build.templates;
    t.is(second.previousContent, "Home v2");

    home.close();
    await server.close();
  });

  test(`Reloads without build.outputs are broadcast unchanged (${mode})`, async (t) => {
    let server = getServer(serverThread);
    let port = await server.getPort();

    let home = await connectPage(port, "/");
    let about = await connectPage(port, "/about/");

    let reloads = Promise.all([home, about].map(ws => nextMessage(ws, "eleventy.reload")));
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

    let bystanderAck = false;
    bystander.on("message", (data) => {
      if(JSON.parse(data.toString()).type === "eleventy.ack") {
        bystanderAck = true;
      }
    });

    let senderAck = nextMessage(sender, "eleventy.ack");
    sender.send(JSON.stringify({ id: "m1", type: "hello", data: {}, timestamp: Date.now() }));
    let message = await clientMessage;
    await senderAck;
    t.is(message.type, "hello");
    t.is(typeof message.clientId, "string");

    let senderReply = nextMessage(sender, "eleventy.msg");
    let bystanderMessage = nextMessage(bystander, "eleventy.msg");
    server.sendUpdateNotification({ type: "eleventy.msg", message: "reply" }, { clientId: message.clientId });
    server.sendUpdateNotification({ type: "eleventy.msg", message: "everyone" });

    t.is((await senderReply).message, "reply");
    t.is((await bystanderMessage).message, "everyone");
    t.false(bystanderAck);

    sender.close();
    bystander.close();
    await server.close();
  });
}
