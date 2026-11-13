import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import DevServer from "../server.js";
import { isHostnameAllowed, isConnectionAllowed, normalizePath, getReloadForPage, EventStreamClient, PageBaselines } from "../server/clientConnection.js";
import { ReloadClient } from "../client/reload-client.js";
import { openEventStream } from "./helpers/eventStream.js";

test("isHostnameAllowed", (t) => {
  assert.ok(isHostnameAllowed("localhost"));
  assert.ok(isHostnameAllowed("site.localhost"));
  assert.ok(isHostnameAllowed("127.0.0.1"));
  assert.ok(isHostnameAllowed("192.168.1.20"));
  assert.ok(isHostnameAllowed("::1"));
  assert.equal(isHostnameAllowed("evil.example"), false);
  assert.equal(isHostnameAllowed(undefined), false);

  assert.ok(isHostnameAllowed("mysite.test", ["mysite.test"]));
  assert.equal(isHostnameAllowed("www.mysite.test", ["mysite.test"]), false);
  assert.ok(isHostnameAllowed("www.mysite.test", [".mysite.test"]));
  assert.ok(isHostnameAllowed("mysite.test", [".mysite.test"]));
  assert.equal(isHostnameAllowed("notmysite.test", [".mysite.test"]), false);
  assert.ok(isHostnameAllowed("anything.example", true));
});

test("isConnectionAllowed", (t) => {
  assert.ok(isConnectionAllowed({ origin: "http://localhost:8080", host: "localhost:8080" }));
  assert.ok(isConnectionAllowed({ origin: "http://[::1]:8080", host: "[::1]:8080" }));
  assert.ok(isConnectionAllowed({ host: "localhost:8080" }), "non-browser clients send no Origin");

  // Other sites
  assert.equal(isConnectionAllowed({ origin: "https://evil.example", host: "localhost:8080" }), false);
  assert.equal(isConnectionAllowed({ origin: "null", host: "localhost:8080" }), false);

  // DNS rebinding: same origin, but a domain name that isn't allowed
  assert.equal(isConnectionAllowed({ origin: "http://evil.example:8080", host: "evil.example:8080" }), false);
  assert.ok(isConnectionAllowed({ origin: "http://mysite.test", host: "mysite.test" }, ["mysite.test"]));

  // `true` skips the Host check, but not the Origin check
  assert.ok(isConnectionAllowed({ origin: "http://evil.example", host: "evil.example" }, true));
  assert.equal(isConnectionAllowed({ origin: "https://evil.example", host: "localhost:8080" }, true), false);
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

test("normalizePath matches the client", (t) => {
  for(let path of ["/", "/index.html", "/about", "/about/", "/about/index.html", "/caf%C3%A9/", "/café/", "/about.html"]) {
    assert.equal(normalizePath(path), ReloadClient.normalizePath(path));
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
  assert.deepEqual(about.build.templates, [{ url: "/about/", content: "About" }]);
  assert.deepEqual({ ...about.build, templates: undefined }, { ...obj.build, templates: undefined });
  assert.equal(about.files, obj.files);
  assert.equal(about.buildId, "b1");

  assert.deepEqual(getReloadForPage(obj, "/missing").build.templates, []);
  assert.deepEqual(getReloadForPage(obj, undefined).build.templates, []);
  assert.equal(obj.build.templates.length, 3);
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
  assert.deepEqual(writes, [`id: b1\ndata: {"a":1}\n\n`]);

  res.writableLength = 3 * 1024 * 1024;
  client.send(`{"a":2}`);
  assert.equal(writes.length, 1);
  assert.ok(destroyed);
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
  assert.equal(first[0].previousContent, "Served");
  assert.equal("previousContent" in first[1], false);
  assert.equal("previousContent" in first[2], false);

  let second = reload("About v3").build.templates;
  assert.equal(second[0].previousContent, "About v2");
  assert.equal(second[1].previousContent, "New");

  let notReload = { type: "eleventy.msg", message: "Hi" };
  assert.equal(baselines.apply(notReload), notReload);
});

for(let serverThread of [true, false]) {
  let mode = serverThread ? "threaded" : "single-threaded";

  test(`Live reload refuses connections from other origins (${mode})`, async (t) => {
    let server = getServer(serverThread);
    let port = await server.getPort();

    let other = await request(port, { headers: { Origin: "https://evil.example" } });
    assert.equal(other.statusCode, 403);

    let rebound = await request(port, { headers: { Origin: `http://evil.example:${port}`, Host: `evil.example:${port}` } });
    assert.equal(rebound.statusCode, 403);

    let same = await request(port, { headers: { Origin: `http://localhost:${port}` } });
    assert.equal(same.statusCode, 200);

    await server.close();
  });

  test(`Live reload only accepts GET (${mode})`, async (t) => {
    let server = getServer(serverThread);
    let port = await server.getPort();

    for(let method of ["POST", "PUT"]) {
      let res = await request(port, { method, headers: { "Content-Type": "application/json", Origin: `http://localhost:${port}` }, body: "{}" });
      assert.equal(res.statusCode, 405);
    }

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
    assert.deepEqual(homeReload.build.templates.map(({ content }) => content), ["Home"]);
    assert.deepEqual(aboutReload.build.templates.map(({ content }) => content), ["About"]);
    assert.deepEqual(otherReload.build.templates, []);
    assert.deepEqual(otherReload.files, ["./_data/site.json"]);
    assert.ok(otherReload.build.outputs);
    assert.equal(otherReload.buildId, homeReload.buildId);
    assert.equal(homeReload.eventId, homeReload.buildId);

    for(let stream of [home, about, other]) {
      stream.close();
    }
    await server.close();
  });

  test(`Reloads include the HTML the page was served, then the last content sent (${mode})`, async (t) => {
    let server = getServer(serverThread);
    let port = await server.getPort();

    let served = (await request(port, { path: "/" })).body;
    assert.ok(served.includes("reload-client.js"));

    let home = await connectPage(port, "/");
    let reload = (content) => {
      let message = home.next("eleventy.reload");
      server.reload({
        files: ["./index.njk"],
        build: { outputs: true, templates: [{ url: "/", inputPath: "./index.njk", content }] },
      });
      return message;
    };

    let [first] = (await reload("Home v2")).build.templates;
    assert.equal(first.previousContent, fs.readFileSync("./test/stubs/index.html", "utf8"));

    let [second] = (await reload("Home v3")).build.templates;
    assert.equal(second.previousContent, "Home v2");

    home.close();
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
      assert.deepEqual(reload.build.templates.map(({ url }) => url), ["/", "/about/"]);
      assert.equal(reload.eventId, reload.buildId);
    }

    home.close();
    about.close();
    await server.close();
  });

  test(`Closing the server ends open streams (${mode})`, async (t) => {
    let server = getServer(serverThread);
    let port = await server.getPort();

    let stream = await connectPage(port, "/");
    assert.equal(stream.status.eventId, stream.status.buildId);

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
    assert.deepEqual(messages.map(({ status }) => status), ["disconnected"]);
  });
}
