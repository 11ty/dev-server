import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import DevServer from "../server.js";

function getOptions(options = {}) {
  options.logger = {
    info: function() {},
    log: function() {},
    error: function() {},
  };
  return options;
}

function testNormalizeFilePath(filepath) {
  return filepath.split("/").join(path.sep);
}

test("Url mappings for resource/index.html", async (t) => {
  let server = new DevServer("test-server", "./test/stubs/", getOptions());

  assert.deepEqual(server.mapUrlToFilePath("/route1/"), {
    statusCode: 200,
    filepath: testNormalizeFilePath("test/stubs/route1/index.html")
  });

  assert.deepEqual(server.mapUrlToFilePath("/route1"), {
    statusCode: 301,
    url: "/route1/"
  });

  assert.deepEqual(server.mapUrlToFilePath("/route1.html"), {
    statusCode: 404
  });

  assert.deepEqual(server.mapUrlToFilePath("/route1/index.html"), {
    statusCode: 200,
    filepath: testNormalizeFilePath("test/stubs/route1/index.html")
  });

  await server.close();
});

test("Url mappings for resource.html", async (t) => {
  let server = new DevServer("test-server", "./test/stubs/", getOptions());

  assert.deepEqual(server.mapUrlToFilePath("/route2/"), {
    statusCode: 301,
    url: "/route2"
  });

  assert.deepEqual(server.mapUrlToFilePath("/route2/index.html"), {
    statusCode: 404
  });

  assert.deepEqual(server.mapUrlToFilePath("/route2"), {
    statusCode: 200,
    filepath: testNormalizeFilePath("test/stubs/route2.html")
  });

  assert.deepEqual(server.mapUrlToFilePath("/route2.html"), {
    statusCode: 200,
    filepath: testNormalizeFilePath("test/stubs/route2.html",)
  });

  await server.close();
});

test("Url mappings for resource.html and resource/index.html", async (t) => {
  let server = new DevServer("test-server", "./test/stubs/", getOptions());

  // Production mismatch warning: Netlify 301 redirects to /route3 here
  assert.deepEqual(server.mapUrlToFilePath("/route3/"), {
    statusCode: 200,
    filepath: testNormalizeFilePath("test/stubs/route3/index.html",)
  });

  assert.deepEqual(server.mapUrlToFilePath("/route3/index.html"), {
    statusCode: 200,
    filepath: testNormalizeFilePath("test/stubs/route3/index.html",)
  });

  assert.deepEqual(server.mapUrlToFilePath("/route3"), {
    statusCode: 200,
    filepath: testNormalizeFilePath("test/stubs/route3.html")
  });

  assert.deepEqual(server.mapUrlToFilePath("/route3.html"), {
    statusCode: 200,
    filepath: testNormalizeFilePath("test/stubs/route3.html",)
  });

  await server.close();
});

test("Url mappings for missing resource", async (t) => {
  let server = new DevServer("test-server", "./test/stubs/", getOptions());

  // 404s
  assert.deepEqual(server.mapUrlToFilePath("/does-not-exist/"), {
    statusCode: 404
  });

  await server.close();
});

test("Url mapping for a filename with a space in it", async (t) => {
  let server = new DevServer("test-server", "./test/stubs/", getOptions());

  assert.deepEqual(server.mapUrlToFilePath("/route space.html"), {
    statusCode: 200,
    filepath: testNormalizeFilePath("test/stubs/route space.html",)
  });

  await server.close();
});

test("matchPassthroughAlias", async (t) => {
  let server = new DevServer("test-server", "./test/stubs/", getOptions());

  // url => project root input
  server.setAliases({
    // works with directories
    "/img": "./test/stubs/img",
    "/elsewhere": "./test/stubs/alternative",
    // or full paths
    "/elsewhere/index.css": "./test/stubs/with-css/style.css",
  });

  // No map entry
  assert.equal(server.matchPassthroughAlias("/"), false);
  assert.equal(server.matchPassthroughAlias("/index.html"), false); // file exists

  // File exists
  assert.equal(server.matchPassthroughAlias("/elsewhere"), "./test/stubs/alternative");
  assert.equal(server.matchPassthroughAlias("/elsewhere/test"), "./test/stubs/alternative/test");

  // Map entry exists but file does not exist
  assert.equal(server.matchPassthroughAlias("/elsewhere/test.png"), false);
  assert.equal(server.matchPassthroughAlias("/elsewhere/another.css"), false);

  // Map entry exists, file exists
  assert.equal(server.matchPassthroughAlias("/elsewhere/index.css"), "./test/stubs/with-css/style.css");

  await server.close();
});


test("pathPrefix matching", async (t) => {
  let server = new DevServer("test-server", "./test/stubs/", getOptions({
    pathPrefix: "/pathprefix/"
  }));

  assert.deepEqual(server.mapUrlToFilePath("/pathprefix/route1/"), {
    statusCode: 200,
    filepath: testNormalizeFilePath("test/stubs/route1/index.html")
  });

  assert.deepEqual(server.mapUrlToFilePath("/pathprefix/"), {
    statusCode: 200,
    filepath: testNormalizeFilePath("test/stubs/index.html")
  });

  // `/` should redirect to pathprefix
  assert.deepEqual(server.mapUrlToFilePath("/"), {
    statusCode: 302,
    url: '/pathprefix/',
  });

  await server.close();
});

test("pathPrefix without leading slash", async (t) => {
  let server = new DevServer("test-server", "./test/stubs/", getOptions({
    pathPrefix: "pathprefix/"
  }));

  assert.deepEqual(server.mapUrlToFilePath("/pathprefix/route1/"), {
    statusCode: 200,
    filepath: testNormalizeFilePath("test/stubs/route1/index.html")
  });

  assert.deepEqual(server.mapUrlToFilePath("/pathprefix/"), {
    statusCode: 200,
    filepath: testNormalizeFilePath("test/stubs/index.html")
  });

  // `/` should redirect to pathprefix
  assert.deepEqual(server.mapUrlToFilePath("/"), {
    statusCode: 302,
    url: '/pathprefix/',
  });

  await server.close();
});

test("pathPrefix without trailing slash", async (t) => {
  let server = new DevServer("test-server", "./test/stubs/", getOptions({
    pathPrefix: "/pathprefix"
  }));

  assert.deepEqual(server.mapUrlToFilePath("/pathprefix/route1/"), {
    statusCode: 200,
    filepath: testNormalizeFilePath("test/stubs/route1/index.html")
  });

  assert.deepEqual(server.mapUrlToFilePath("/pathprefix/"), {
    statusCode: 200,
    filepath: testNormalizeFilePath("test/stubs/index.html")
  });

  // `/` should redirect to pathprefix
  assert.deepEqual(server.mapUrlToFilePath("/"), {
    statusCode: 302,
    url: '/pathprefix/',
  });

  await server.close();
});

test("pathPrefix without leading or trailing slash", async (t) => {
  let server = new DevServer("test-server", "./test/stubs/", getOptions({
    pathPrefix: "pathprefix"
  }));

  assert.deepEqual(server.mapUrlToFilePath("/pathprefix/route1/"), {
    statusCode: 200,
    filepath: testNormalizeFilePath("test/stubs/route1/index.html")
  });

  assert.deepEqual(server.mapUrlToFilePath("/pathprefix/"), {
    statusCode: 200,
    filepath: testNormalizeFilePath("test/stubs/index.html")
  });

  // `/` should redirect to pathprefix
  assert.deepEqual(server.mapUrlToFilePath("/"), {
    statusCode: 302,
    url: '/pathprefix/',
  });

  await server.close();
});

test("indexFileName option: serve custom index when provided", async (t) => {
  let server = new DevServer("test-server", "./test/stubs/", getOptions({ indexFileName: 'custom-index.html' }));

  assert.deepEqual(server.mapUrlToFilePath("/"), {
    statusCode: 200,
    filepath: testNormalizeFilePath("test/stubs/custom-index.html"),
  });


  assert.deepEqual(server.mapUrlToFilePath("/route1/"), {
    statusCode: 200,
    filepath: testNormalizeFilePath("test/stubs/route1/custom-index.html"),
  });

  await server.close();
});

test("indexFileName option: return 404 when custom index file doesn't exist", async (t) => {
  let server = new DevServer("test-server", "./test/stubs/", getOptions({ indexFileName: 'does-not-exist.html' }));

  assert.deepEqual(server.mapUrlToFilePath("/"), {
    statusCode: 404,
  });

  await server.close();
});

test("Test watch getter", async (t) => {
  let server = new DevServer("test-server", "./test/stubs/", getOptions());

  assert.ok(server.watcher);

  await server.close();
});

test("Encoded traversal to a sibling directory is refused", async (t) => {
  let server = new DevServer("test-server", "./test/stubs/", getOptions());

  for(let url of [
    "/%2e%2e%2fstubs-sibling%2fsecret.txt",
    "/..%2fstubs-sibling%2fsecret.txt",
    "/..%5cstubs-sibling%5csecret.txt",
    "/%2e%2e/stubs-sibling/secret.txt",
    "/../stubs-sibling/secret.txt",
    "/%E0%A4%A",
  ]) {
    assert.deepEqual(server.mapUrlToFilePath(url), { statusCode: 404 }, url);
  }

  assert.throws(() => server.getOutputDirFilePath("/..%2fstubs-sibling%2fsecret.txt"), { message: "Invalid path" });
  assert.throws(() => server.getOutputDirFilePath("/../stubs-sibling/secret.txt"), { message: "Invalid path" });

  await server.close();
});

test("isFileInDirectory doesn't match sibling directories that share a prefix", async (t) => {
  let server = new DevServer("test-server", "./test/stubs/", getOptions());

  assert.ok(server.isFileInDirectory("test/stubs", "test/stubs/index.html"));
  assert.ok(server.isFileInDirectory("test/stubs", "test/stubs"));
  assert.equal(server.isFileInDirectory("test/stubs", "test/stubs-sibling/secret.txt"), false);
  assert.equal(server.isFileInDirectory("test/stubs", "test/stubs.html"), false);
  assert.equal(server.isFileInDirectory("test/stubs", "test"), false);

  await server.close();
});

test("Custom error pages are limited to allowed status codes", async (t) => {
  let { default: StaticFiles, CUSTOM_ERROR_PAGE_STATUSES } = await import("../server/staticFiles.js");
  let staticFiles = new StaticFiles("./test/stubs-error-pages/", { pathPrefix: "/", indexFileName: "index.html", aliases: {}, headers: {}, encoding: "utf-8", logger: { info() {}, log() {}, error() {} } });

  assert.deepEqual([...CUSTOM_ERROR_PAGE_STATUSES], [404, 500]);

  function send(statusCode) {
    let res = {
      statusCode: 200,
      headers: {},
      headersSent: false,
      setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
      getHeader(key) { return this.headers[key.toLowerCase()]; },
      removeHeader(key) { delete this.headers[key.toLowerCase()]; },
      end(body) { this.body = String(body ?? ""); },
    };
    staticFiles.sendError({ method: "GET" }, res, statusCode, "Built-in");
    return res;
  }

  assert.ok(send(404).body.includes("CUSTOM-404"));
  assert.ok(send(500).body.includes("CUSTOM-500"));

  // `403.html` exists in the fixture but isn't allowed
  let forbidden = send(403);
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.body.includes("CUSTOM-403"), false);
  assert.ok(forbidden.body.includes("<pre>Built-in</pre>"));
});

test("Root requests don't pass an invalid path to fs.existsSync", async (t) => {
  let warnings = [];
  let onWarning = (warning) => warnings.push(warning.code);
  process.on("warning", onWarning);

  let server = new DevServer("test-server", "./test/stubs/", getOptions());
  assert.deepEqual(server.mapUrlToFilePath("/"), { statusCode: 200, filepath: testNormalizeFilePath("test/stubs/index.html") });
  await new Promise((resolve) => setImmediate(resolve));

  process.off("warning", onWarning);
  assert.equal(warnings.includes("DEP0187"), false);
  await server.close();
});

// macOS and Windows usually have case-insensitive file systems; Linux doesn't
const isCaseInsensitiveFileSystem = fs.existsSync("test/stubs/SAMPLE.html");

test("URLs must match the case of files on disk", async (t) => {
  let server = new DevServer("test-server", "./test/stubs/", getOptions());

  assert.equal(server.mapUrlToFilePath("/sample").statusCode, 200);
  assert.deepEqual(server.mapUrlToFilePath("/SAMPLE"), { statusCode: 404 });
  assert.deepEqual(server.mapUrlToFilePath("/Route1/"), { statusCode: 404 });
  assert.deepEqual(server.mapUrlToFilePath("/Route1"), { statusCode: 404 });
  assert.deepEqual(server.mapUrlToFilePath("/route1/INDEX.html"), { statusCode: 404 });
  assert.equal(server.mapUrlToFilePath(encodeURI("/zach’s.html")).statusCode, 200);

  await server.close();
});

test("Passthrough aliases must match the case of files on disk", async (t) => {
  let server = new DevServer("test-server", "./test/stubs/", getOptions());
  server.setAliases({ "/elsewhere": "./test/stubs/alternative" });

  assert.equal(server.matchPassthroughAlias("/elsewhere/test"), "./test/stubs/alternative/test");
  assert.equal(server.matchPassthroughAlias("/elsewhere/TEST"), false);

  await server.close();
});

test("Passthrough aliases skip OS junk files but not other dotfiles", async (t) => {
  let server = new DevServer("test-server", "./test/stubs/", getOptions());
  server.setAliases({ "/junk/": "./test/stubs-passthrough-junk/" });

  assert.equal(server.matchPassthroughAlias("/junk/Thumbs.db"), false);
  assert.deepEqual(server.mapUrlToFilePath("/junk/Thumbs.db"), { statusCode: 404 });

  // copied, but not served
  assert.equal(server.matchPassthroughAlias("/junk/.htaccess"), "./test/stubs-passthrough-junk/.htaccess");
  assert.deepEqual(server.mapUrlToFilePath("/junk/.htaccess"), { statusCode: 404 });

  assert.equal(server.matchPassthroughAlias("/junk/file.txt"), "./test/stubs-passthrough-junk/file.txt");
  assert.equal(server.mapUrlToFilePath("/junk/file.txt").statusCode, 200);

  await server.close();
});

test("Dotfiles are not served, except `/.well-known/`", async (t) => {
  let server = new DevServer("test-server", "./test/stubs-passthrough-junk/", getOptions());

  assert.deepEqual(server.mapUrlToFilePath("/.htaccess"), { statusCode: 404 });
  assert.deepEqual(server.mapUrlToFilePath("/%2Ehtaccess"), { statusCode: 404 });
  assert.deepEqual(server.mapUrlToFilePath("/.well-known/.hidden"), { statusCode: 404 });
  assert.deepEqual(server.mapUrlToFilePath("/sub/.well-known/security.txt"), { statusCode: 404 });
  assert.equal(server.mapUrlToFilePath("/.well-known/security.txt").statusCode, 200);
  assert.equal(server.mapUrlToFilePath("/file.txt").statusCode, 200);

  await server.close();
});

test("Dotfiles are served with `dotfiles: true`", async (t) => {
  let server = new DevServer("test-server", "./test/stubs-passthrough-junk/", getOptions({ dotfiles: true }));
  server.setAliases({ "/junk/": "./test/stubs-passthrough-junk/" });

  assert.equal(server.mapUrlToFilePath("/.htaccess").statusCode, 200);
  assert.equal(server.mapUrlToFilePath("/.well-known/.hidden").statusCode, 200);
  assert.equal(server.mapUrlToFilePath("/junk/.htaccess").statusCode, 200);

  await server.close();
});

test("Passthrough aliases serve `/.well-known/`", async (t) => {
  let server = new DevServer("test-server", "./test/stubs/", getOptions());
  server.setPassthroughCopies([{ url: "/.well-known/", inputPath: "./test/stubs-passthrough-junk/.well-known/" }]);

  assert.equal(server.mapUrlToFilePath("/.well-known/security.txt").statusCode, 200);

  await server.close();
});

test("Passthrough copies apply `dot` and `junk` like passthrough copy", async (t) => {
  let server = new DevServer("test-server", "./test/stubs/", getOptions());
  server.setPassthroughCopies([
    { url: "/junk/", inputPath: "./test/stubs-passthrough-junk/", dot: true, junk: true },
    { url: "/no-dot/", inputPath: "./test/stubs-passthrough-junk/", dot: false, junk: false },
    { url: "/thumbs.db", inputPath: "./test/stubs-passthrough-junk/Thumbs.db" },
  ]);

  assert.equal(server.matchPassthroughAlias("/junk/Thumbs.db"), "./test/stubs-passthrough-junk/Thumbs.db");
  assert.equal(server.matchPassthroughAlias("/no-dot/.htaccess"), false);
  assert.equal(server.matchPassthroughAlias("/no-dot/file.txt"), "./test/stubs-passthrough-junk/file.txt");
  // Passthrough copy skips a junk file copied directly, too
  assert.equal(server.matchPassthroughAlias("/thumbs.db"), false);

  await server.close();
});

test("`aliases` option entries serve OS junk files", async (t) => {
  let server = new DevServer("test-server", "./test/stubs/", getOptions({
    aliases: { "/junk/": "./test/stubs-passthrough-junk/" },
  }));

  assert.equal(server.matchPassthroughAlias("/junk/Thumbs.db"), "./test/stubs-passthrough-junk/Thumbs.db");

  await server.close();
});

test("caseSensitive: false serves any case on case-insensitive file systems", async (t) => {
  let server = new DevServer("test-server", "./test/stubs/", getOptions({ caseSensitive: false }));

  assert.equal(server.mapUrlToFilePath("/SAMPLE").statusCode, isCaseInsensitiveFileSystem ? 200 : 404);
  assert.equal(server.mapUrlToFilePath("/Route1/").statusCode, isCaseInsensitiveFileSystem ? 200 : 404);

  await server.close();
});
