import test from "ava";
import http from "http";
import EleventyDevServer from "../server.js";

function getOptions(options = {}) {
  options.logger = {
    info: function() {},
    log: function() {},
    error: function() {},
  };
  options.portReassignmentRetryCount = 100;
  return options;
}

async function makeRequestTo(t, server, path) {
  let port = await server.getPort();

  return new Promise(resolve => {
    const options = {
      hostname: 'localhost',
      port,
      path,
      method: 'GET',
    };

    http.get(options, (res) => {
      const { statusCode } = res;
      if(statusCode !== 200) {
        throw new Error("Invalid status code" + statusCode);
      }

      res.setEncoding('utf8');

      let rawData = '';
      res.on('data', (chunk) => { rawData += chunk; });
      res.on('end', () => {
        t.true( true );
        resolve(rawData);
      });
    }).on('error', (e) => {
      console.error(`Got error: ${e.message}`);
    });
  })
}

async function fetchHeadersForRequest(t, server, path, extras) {
  let port = await server.getPort();

  return new Promise(resolve => {
    const options = {
      hostname: 'localhost',
      port,
      path,
      method: 'GET',
      ...extras,
    };

    // Available status codes can be found here: http.STATUS_CODES
    const successCodes = [
      200, // OK
      206, // Partial Content
    ];
    http.get(options, (res) => {
      const { statusCode } = res;
      if (!successCodes.includes(statusCode)) {
        throw new Error("Invalid status code " + statusCode);
      }

      let headers = res.headers;
      resolve(headers);

    }).on('error', (e) => {
      console.error(`Got error: ${e.message}`);
    });
  })
}

test("Standard request", async (t) => {
  let server = new EleventyDevServer("test-server", "./test/stubs/", getOptions());
  server.serve(8100);

  let data = await makeRequestTo(t, server, "/sample");
  t.true(data.includes("<script "));
  t.true(data.startsWith("SAMPLE"));

  await server.close();  
});

test("One sync middleware", async t => {
  let server = new EleventyDevServer("test-server", "./test/stubs/", getOptions({
    middleware: [
      function(req, res, next) {
        return next();
      }
    ],
  }));

  server.serve(8100);

  let data = await makeRequestTo(t, server, "/sample");
  t.true(data.includes("<script "));
  t.true(data.startsWith("SAMPLE"));

  await server.close();
});

test("Two sync middleware", async t => {
  let server = new EleventyDevServer("test-server", "./test/stubs/", getOptions({
    middleware: [
      function(req, res, next) {
        return next();
      },
      function(req, res, next) {
        return next();
      }
    ],
  }));
  server.serve(8100);

  let data = await makeRequestTo(t, server, "/sample");
  t.true(data.includes("<script "));
  t.true(data.startsWith("SAMPLE"));

  await server.close();
});

test("One async middleware", async t => {
  let server = new EleventyDevServer("test-server", "./test/stubs/", getOptions({
    middleware: [
      async function(req, res, next) {
        return next();
      }
    ],
  }));
  server.serve(8100);

  let data = await makeRequestTo(t, server, "/sample");
  t.true(data.includes("<script "));
  t.true(data.startsWith("SAMPLE"));

  await server.close();
});

test("Two async middleware", async t => {
  let server = new EleventyDevServer("test-server", "./test/stubs/", getOptions({
    middleware: [
      async function(req, res, next) {
        return next();
      },
      async function(req, res, next) {
        return next();
      }
    ],
  }));
  server.serve(8100);

  let data = await makeRequestTo(t, server, "/sample");
  t.true(data.includes("<script "));
  t.true(data.startsWith("SAMPLE"));

  await server.close();
});

test("Async middleware that writes", async t => {
  let server = new EleventyDevServer("test-server", "./test/stubs/", getOptions({
    // enabled: false,
    middleware: [
      async function(req, res, next) {
        let data = await new Promise((resolve) => {
          setTimeout(() => {
            resolve("Injected")
          }, 10);
        });

        res.writeHead(200, {
          "Content-Type": "text/html",
        });
        res.write("Injected");
        res.end();
      },
    ],
  }));
  server.serve(8100);

  let data = await makeRequestTo(t, server, "/sample");
  t.true(data.includes("<script "));
  t.true(data.startsWith("Injected"));

  await server.close();
});

test("Second async middleware that writes", async t => {
  let server = new EleventyDevServer("test-server", "./test/stubs/", getOptions({
    // enabled: false,
    middleware: [
      async function(req, res, next) {
        await new Promise((resolve) => {
          setTimeout(() => {
            resolve()
          }, 10);
        });

        next()
      },
      async function(req, res, next) {
        let data = await new Promise((resolve) => {
          setTimeout(() => {
            resolve("Injected")
          }, 10);
        });

        res.writeHead(200, {
          "Content-Type": "text/html",
        });
        res.write(data);
        res.end();
      },
    ],
  }));
  server.serve(8100);

  let data = await makeRequestTo(t, server, "/sample");
  t.true(data.includes("<script "));
  t.true(data.startsWith("Injected"));

  await server.close();
});


test("Second middleware that consumes first middleware response body, issue #29", async t => {
  let server = new EleventyDevServer("test-server", "./test/stubs/", getOptions({
    // enabled: false,
    middleware: [
      async function(req, res, next) {
        res.writeHead(200, {"Content-Type": "text/html"});
        res.write("First ");

        next()
      },
      async function(req, res, next) {
        res.body += "Second ";
        // No need for `next()` when you do `end()`
        res.end();
      },
    ],
  }));
  server.serve(8100);

  let data = await makeRequestTo(t, server, "/sample");
  t.true(data.includes("<script "));
  t.true(data.startsWith("First Second "));

  await server.close();
});

test("Two middlewares, end() in the first, skip the second", async t => {
  let server = new EleventyDevServer("test-server", "./test/stubs/", getOptions({
    // enabled: false,
    middleware: [
      async function(req, res, next) {
        res.writeHead(200, {"Content-Type": "text/html"});
        res.write("First ");
        res.end();
      },
      async function(req, res, next) {
        res.body += "Second ";

        next();
      },
    ],
  }));
  server.serve(8100);

  let data = await makeRequestTo(t, server, "/sample");
  t.true(data.includes("<script "));
  t.true(data.startsWith("First "));
  t.true(!data.startsWith("First Second "));

  await server.close();
});

test("Fun unicode paths", async t => {
  let server = new EleventyDevServer("test-server", "./test/stubs/", getOptions());
  server.serve(8100);

  let data = await makeRequestTo(t, server, encodeURI(`/zach’s.html`));
  t.true(data.includes("<script "));
  t.true(data.startsWith("This is a test"));

  await server.close();
});

test("Content-Type header via middleware", async t => {
  let server = new EleventyDevServer("test-server", "./test/stubs/", getOptions({
    middleware: [
      function (req, res, next) {
        if (/.*\.php$/.test(req.url)) {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
        }

        next();
      }
    ]
  }));
  server.serve(8100);

  let data = await fetchHeadersForRequest(t, server, encodeURI(`/index.php`));
  t.true(data['content-type'] === 'text/html; charset=utf-8');

  await server.close();
});

test("Content-Range request", async (t) => {
  let server = new EleventyDevServer(
    "test-server",
    "./test/stubs/",
    getOptions()
  );
  server.serve(8100);

  const options = { headers: { Range: "bytes=0-48" } };
  let data = await fetchHeadersForRequest(t, server, `/index.html`, options);
  t.true("accept-ranges" in data);
  t.true(data["accept-ranges"] === "bytes");
  t.true("content-range" in data);
  t.true(data["content-range"].startsWith("bytes 0-48/"));

  await server.close();
});

test("Standard request does not include range headers", async (t) => {
  let server = new EleventyDevServer(
    "test-server",
    "./test/stubs/",
    getOptions()
  );
  server.serve(8100);

  let data = await fetchHeadersForRequest(t, server, `/index.html`);
  t.false("accept-ranges" in data);
  t.false("content-range" in data);

  await server.close();
});

test("Setting default response headers", async (t) => {
  let server = new EleventyDevServer(
    "test-server",
    "./test/stubs/",
    getOptions({
      headers: {
        "access-control-allow-origin": "*",
        "x-foo": "y-bar",
      }
    })
  );
  server.serve(8100);

  let data = await fetchHeadersForRequest(t, server, "/index.html");
  t.true(data["access-control-allow-origin"] === "*");
  t.true(data["x-foo"] === "y-bar");

  await server.close();
});

test("Default response headers cannot overwrite content-type", async (t) => {
  let server = new EleventyDevServer(
    "test-server",
    "./test/stubs/",
    getOptions({
      headers: {
        "Content-Type": "text/plain",
      }
    })
  );
  server.serve(8100);

  let data = await fetchHeadersForRequest(t, server, "/index.html");
  t.false(data["Content-Type"] === "text/plain");

  await server.close();
});
