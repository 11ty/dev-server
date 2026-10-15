const test = require("ava");
const fs = require("node:fs");
const path = require("node:path");
const EleventyDevServer = require("../");
const WatchTargets = require("../server/watchTargets.js");

test("WatchTargets maps globs to base directories", (t) => {
  let targets = new WatchTargets();
  t.deepEqual(targets.add(["./src/**/*.css", "*.js", "public", "!**/*.tmp"]), ["src", ".", "public"]);
});

test("WatchTargets matching", (t) => {
  let targets = new WatchTargets();
  targets.add(["./src/**/*.{css,js}", "public/", "!**/*.tmp"]);

  t.true(targets.isWatched("src/a/b.css"));
  t.true(targets.isWatched("src\\a\\b.js"));
  t.true(targets.isWatched("src/.hidden/b.css"));
  t.false(targets.isWatched("src/a/b.html"));
  t.true(targets.isWatched("public/index.html"));
  t.false(targets.isWatched("publicity/index.html"));
  t.false(targets.isWatched("public/index.tmp"));
});

test("WatchTargets ignores files but not directories", (t) => {
  let targets = new WatchTargets();
  targets.add(["src/**/*.css"]);
  let file = { isFile: () => true };
  let dir = { isFile: () => false };

  t.false(targets.isIgnored("src/a", dir));
  t.false(targets.isIgnored("src/a/b.css", file));
  t.true(targets.isIgnored("src/a/b.html", file));
  t.true(targets.isIgnored("src/node_modules/a.css", file));
  t.true(targets.isIgnored(".git", dir));
  t.false(targets.isIgnored("src/.git", dir));
});

function waitFor(condition, timeout = 3000) {
  return new Promise((resolve, reject) => {
    let start = Date.now();
    let interval = setInterval(() => {
      if(condition()) {
        clearInterval(interval);
        resolve();
      } else if(Date.now() - start > timeout) {
        clearInterval(interval);
        reject(new Error("Timed out"));
      }
    }, 25);
  });
}

test("Glob in watch option only reloads matching files", async (t) => {
  let dir = fs.mkdtempSync(path.join("test", ".watch-"));
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

  let server = new EleventyDevServer("test-server", dir, {
    watch: [`${dir}/**/*.css`],
    logger: { log() {}, info() {}, error() {} },
  });
  let reloaded = [];
  server.reloadFiles = (files) => reloaded.push(...files.map(f => f.split(path.sep).join("/")));

  let watcher = server.getWatcher();
  await new Promise(resolve => watcher.once("ready", resolve));

  fs.writeFileSync(path.join(dir, "index.html"), "");
  fs.writeFileSync(path.join(dir, "style.css"), "");
  await waitFor(() => reloaded.length > 0);
  await new Promise(resolve => setTimeout(resolve, 300));

  t.deepEqual(reloaded, [`${dir}/style.css`]);

  await server.close();
});
