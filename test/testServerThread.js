import test from "ava";
import http from "http";
import { Worker } from "node:worker_threads";
import DevServer from "../server.js";

// The dev server runs its HTTP server on a worker thread by default so that
// requests stay fast while a build occupies the main thread. These tests assert
// that the threaded and single-threaded paths behave identically.

function getOptions(options = {}) {
  options.logger = {
    info: function() {},
    log: function() {},
    error: function() {},
  };
  options.portReassignmentRetryCount = 100;
  return options;
}

async function request(server, path) {
  let port = await server.getPort();

  return new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port, path, method: "GET" }, (res) => {
      res.setEncoding("utf8");
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        resolve({ statusCode: res.statusCode, headers: res.headers, body });
      });
    }).on("error", reject);
  });
}

// Runs `fn` against a server in both modes and hands back both results.
async function inBothModes(options, fn) {
  let results = {};
  for(let serverThread of [true, false]) {
    let server = new DevServer("test-server", "./test/stubs/", getOptions(
      Object.assign({}, options, { serverThread })
    ));
    server.serve(0);
    try {
      results[serverThread ? "threaded" : "single"] = await fn(server);
    } finally {
      await server.close();
    }
  }
  return results;
}

test("serverThread is on by default", async (t) => {
  let server = new DevServer("test-server", "./test/stubs/", getOptions());
  t.true(server.isThreaded);
  await server.close();

  let optOut = new DevServer("test-server", "./test/stubs/", getOptions({ serverThread: false }));
  t.false(optOut.isThreaded);
  await optOut.close();
});

test("Static file responses match in both modes", async (t) => {
  let { threaded, single } = await inBothModes({}, (server) => request(server, "/sample"));

  t.true(threaded.body.startsWith("SAMPLE"));
  t.true(threaded.body.includes("<script "));
  t.is(threaded.statusCode, 200);
  t.is(threaded.body, single.body);
  t.is(threaded.headers["content-type"], single.headers["content-type"]);
});

test("404 responses match in both modes", async (t) => {
  let { threaded, single } = await inBothModes({}, (server) => request(server, "/this-does-not-exist"));

  t.is(threaded.statusCode, 404);
  t.is(single.statusCode, 404);
  // the reload client is injected into error pages too
  t.true(threaded.body.includes("<script "));
  t.is(threaded.body, single.body);
});

test("Redirects match in both modes", async (t) => {
  let { threaded, single } = await inBothModes({}, (server) => request(server, "/route1"));

  t.is(threaded.statusCode, 301);
  t.is(threaded.headers.location, "/route1/");
  t.is(single.statusCode, threaded.statusCode);
  t.is(single.headers.location, threaded.headers.location);
});

test("onRequest is proxied to the main thread", async (t) => {
  let options = {
    onRequest: {
      "/dynamic/:name": ({ patternGroups }) => {
        return {
          headers: { "Content-Type": "text/html" },
          body: `DYNAMIC:${patternGroups.name}`,
        };
      },
    },
  };

  let { threaded, single } = await inBothModes(options, (server) => request(server, "/dynamic/zach"));

  t.true(threaded.body.startsWith("DYNAMIC:zach"));
  // onRequest HTML still gets the live reload client injected
  t.true(threaded.body.includes("<script "));
  t.is(threaded.body, single.body);
});

test("onRequest returning nothing falls through to static files", async (t) => {
  let options = {
    onRequest: {
      "/sample": () => undefined,
    },
  };

  let { threaded, single } = await inBothModes(options, (server) => request(server, "/sample"));

  t.true(threaded.body.startsWith("SAMPLE"));
  t.is(threaded.body, single.body);
});

test("Middleware that ends the response is proxied", async (t) => {
  let options = {
    middleware: [
      async function(req, res, next) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("FROM-MIDDLEWARE");
      },
    ],
  };

  let { threaded, single } = await inBothModes(options, (server) => request(server, "/sample"));

  t.true(threaded.body.startsWith("FROM-MIDDLEWARE"));
  t.true(threaded.body.includes("<script "));
  t.is(threaded.body, single.body);
});

test("Middleware headers survive fallthrough to the server thread", async (t) => {
  let options = {
    middleware: [
      function(req, res, next) {
        res.setHeader("X-From-Middleware", "yes");
        next();
      },
    ],
  };

  let { threaded, single } = await inBothModes(options, (server) => request(server, "/sample"));

  // the middleware fell through, so the file is served by the server thread,
  // but the header the middleware set must still be present
  t.is(threaded.headers["x-from-middleware"], "yes");
  t.true(threaded.body.startsWith("SAMPLE"));
  t.is(threaded.headers["x-from-middleware"], single.headers["x-from-middleware"]);
  t.is(threaded.body, single.body);
});

test("Aliases set before serve() reach the server thread", async (t) => {
  let results = {};
  for(let serverThread of [true, false]) {
    let server = new DevServer("test-server", "./test/stubs/", getOptions({ serverThread }));
    server.setAliases({ "/aliased": "./test/stubs/sample.html" });
    server.serve(0);
    results[serverThread ? "threaded" : "single"] = await request(server, "/aliased");
    await server.close();
  }

  t.true(results.threaded.body.startsWith("SAMPLE"));
  t.is(results.threaded.body, results.single.body);
});

test("Injected scripts are served off the main thread", async (t) => {
  let { threaded, single } = await inBothModes({}, async (server) => {
    return {
      client: await request(server, "/.11ty/reload-client.js"),
      morphdom: await request(server, "/.11ty/morphdom.js"),
    };
  });

  t.is(threaded.client.statusCode, 200);
  t.is(threaded.morphdom.statusCode, 200);
  t.is(threaded.client.body, single.client.body);
  t.is(threaded.morphdom.body, single.morphdom.body);
});

test("Requests are served while the main thread is blocked", async (t) => {
  // The probe has to run off the main thread, otherwise it would be blocked
  // alongside the server and the test would pass no matter what.
  const PROBE = `
import http from "node:http";
import { workerData, parentPort } from "node:worker_threads";
const { port, durationMs } = workerData;
const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
function once() {
  return new Promise((resolve) => {
    let start = Date.now();
    http.get({ hostname: "127.0.0.1", port, path: "/sample", agent }, (res) => {
      res.resume();
      res.on("end", () => resolve(Date.now() - start));
    }).on("error", () => resolve(Date.now() - start));
  });
}
let max = 0, count = 0;
let deadline = Date.now() + durationMs;
while(Date.now() < deadline) { max = Math.max(max, await once()); count++; }
parentPort.postMessage({ max, count });
`;

  const BLOCK_MS = 500;

  async function maxLatencyWhileBlocked(serverThread) {
    let server = new DevServer("test-server", "./test/stubs/", getOptions({ serverThread }));
    server.serve(0);
    let port = await server.getPort();

    let probe = new Worker(PROBE, { eval: true, workerData: { port, durationMs: 1200 } });
    let result = new Promise((resolve) => probe.once("message", resolve));

    await new Promise((resolve) => setTimeout(resolve, 300)); // let the probe warm up

    let end = Date.now() + BLOCK_MS;
    while(Date.now() < end) {} // eslint-disable-line no-empty -- block the main thread like a build does

    let { max } = await result;
    await probe.terminate();
    await server.close();
    return max;
  }

  let threaded = await maxLatencyWhileBlocked(true);
  let single = await maxLatencyWhileBlocked(false);

  // Control: without the server thread, a request must wait out the whole block.
  // This is what keeps the assertion below honest.
  t.true(single >= BLOCK_MS / 2, `expected single-threaded to stall, worst request took ${single}ms`);

  // With the server thread, requests are answered during the block.
  t.true(threaded < BLOCK_MS / 4, `expected fast responses during the block, worst request took ${threaded}ms`);
});

async function sendRequest(server, path, { method = "GET", body } = {}) {
  let port = await server.getPort();

  return new Promise((resolve, reject) => {
    let req = http.request({ hostname: "127.0.0.1", port, path, method }, (res) => {
      res.setEncoding("utf8");
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if(body) {
      req.write(body);
    }
    req.end();
  });
}

test("Request bodies are proxied to middleware", async (t) => {
  let options = {
    middleware: [
      function(req, res, next) {
        let chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          res.setHeader("Content-Type", "text/plain");
          res.end(`GOT:${Buffer.concat(chunks).toString()}`);
        });
      },
    ],
  };

  let { threaded, single } = await inBothModes(options, (server) => {
    return sendRequest(server, "/anything", { method: "POST", body: "hello=world" });
  });

  t.is(threaded.body, "GOT:hello=world");
  t.is(threaded.body, single.body);
});

test("A throwing middleware does not take down the server", async (t) => {
  let server = new DevServer("test-server", "./test/stubs/", getOptions({
    middleware: [
      function(req, res, next) {
        if(req.url === "/boom") {
          throw new Error("middleware exploded");
        }
        next();
      },
    ],
  }));
  server.serve(0);

  let failed = await sendRequest(server, "/boom");
  t.is(failed.statusCode, 500);

  // the server thread must survive and keep serving
  let after = await sendRequest(server, "/sample");
  t.is(after.statusCode, 200);
  t.true(after.body.startsWith("SAMPLE"));

  await server.close();
});

function withTimeout(promise, ms = 2000) {
  return Promise.race([
    promise,
    new Promise((resolve, reject) => setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)),
  ]);
}

test("getPort() rejects when every port is in use", async (t) => {
  let blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(0, resolve));

  let server = new DevServer("test-server", "./test/stubs/", getOptions());
  server.options.portReassignmentRetryCount = 0;
  server.serve(blocker.address().port);

  await t.throwsAsync(withTimeout(server.getPort()), { message: /ports but they were all in use/ });
  await t.throwsAsync(withTimeout(server.ready()));

  await server.close();
  await new Promise((resolve) => blocker.close(resolve));
});

test("getPort() rejects when the server thread fails to start", async (t) => {
  let server = new DevServer("test-server", "./test/stubs/", getOptions({
    https: { key: "./does-not-exist.key", cert: "./does-not-exist.cert" },
  }));
  server.serve(0);

  await t.throwsAsync(withTimeout(server.getPort()), { message: /exited unexpectedly/ });

  await server.close();
});

test("Streaming middleware responses reach the client before they end", async (t) => {
  let firstChunkReceived;
  let firstChunkPromise = new Promise((resolve) => firstChunkReceived = resolve);

  let server = new DevServer("test-server", "./test/stubs/", getOptions({
    middleware: [
      async function(req, res, next) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        // Buffers stream through; strings are held until `end()` by the response wrapper
        res.write(Buffer.from("first"));
        await firstChunkPromise;
        res.end(Buffer.from("second"));
      },
    ],
  }));
  server.serve(0);
  let port = await server.getPort();

  let body = await withTimeout(new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port, path: "/stream" }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
        firstChunkReceived();
      });
      res.on("end", () => resolve(body));
    }).on("error", reject);
  }));

  t.is(body, "firstsecond");

  await server.close();
});

test("Proxied middleware sees the client disconnect", async (t) => {
  let closed;
  let closedPromise = new Promise((resolve) => closed = resolve);

  let server = new DevServer("test-server", "./test/stubs/", getOptions({
    middleware: [
      function(req, res, next) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(Buffer.from("data: hello\n\n"));
        res.on("close", closed);
      },
    ],
  }));
  server.serve(0);
  let port = await server.getPort();

  let request = http.get({ hostname: "127.0.0.1", port, path: "/events" }, (res) => {
    res.once("data", () => request.destroy());
  });
  request.on("error", () => {});

  await t.notThrowsAsync(withTimeout(closedPromise));

  await server.close();
});

test("Proxied requests expose socket details to middleware", async (t) => {
  let options = {
    middleware: [
      function(req, res, next) {
        res.setHeader("Content-Type", "text/plain");
        res.end(`${Boolean(req.socket.remoteAddress)}`);
      },
    ],
  };

  let { threaded, single } = await inBothModes(options, (server) => request(server, "/socket"));

  t.is(threaded.body, "true");
  t.is(threaded.body, single.body);
});

test("Reloads with values that can't be cloned reach clients", async (t) => {
  let server = new DevServer("test-server", "./test/stubs/", getOptions());
  server.serve(0);
  let port = await server.getPort();

  let socket = new WebSocket(`ws://localhost:${port}`);
  let messages = [];
  let reloadMessage = new Promise((resolve) => {
    socket.addEventListener("message", (event) => {
      let data = JSON.parse(event.data);
      messages.push(data);
      if(data.type === "eleventy.status") {
        server.reload({
          files: ["./index.njk"],
          build: {
            outputs: true,
            templates: [{ url: "/", inputPath: "./index.njk", content: "Home", data: { fn() {} } }],
          },
        });
      } else if(data.type === "eleventy.reload") {
        resolve(data);
      }
    });
  });

  let reload = await withTimeout(reloadMessage);
  t.is(reload.build.templates[0].url, "/");
  t.deepEqual(reload.build.templates[0].data, {});

  socket.close();
  await server.close();
});

test("Event stream string writes reach the client before they end, in both modes", async (t) => {
  for(let serverThread of [true, false]) {
    let firstChunkReceived;
    let firstChunkPromise = new Promise((resolve) => firstChunkReceived = resolve);

    let server = new DevServer("test-server", "./test/stubs/", getOptions({
      serverThread,
      middleware: [
        async function(req, res, next) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write("data: first\n\n");
          await firstChunkPromise;
          res.end("data: second\n\n");
        },
      ],
    }));
    server.serve(0);
    let port = await server.getPort();

    let body = await withTimeout(new Promise((resolve, reject) => {
      http.get({ hostname: "127.0.0.1", port, path: "/events" }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
          firstChunkReceived();
        });
        res.on("end", () => resolve(body));
      }).on("error", reject);
    }));

    t.is(body, "data: first\n\ndata: second\n\n", `serverThread: ${serverThread}`);

    await server.close();
  }
});

test("Encoded traversal to a sibling directory is refused in both modes", async (t) => {
  let { threaded, single } = await inBothModes({}, (server) => request(server, "/..%2fstubs-sibling%2fsecret.txt"));

  t.is(threaded.statusCode, 404);
  t.is(single.statusCode, 404);
  t.false(threaded.body.includes("SECRET"));
  t.false(single.body.includes("SECRET"));
});
