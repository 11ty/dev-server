import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";
import chokidar from "@11ty/chokidar-with-glob-support";
import DevServer from "../server.js";

function getOptions(options = {}) {
  options.logger = {
    info: function() {},
    log: function() {},
    error: function() {},
  };
  return options;
}

function getTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "eleventy-dev-server-watch-"));
}

function waitForReload(server) {
  return new Promise(resolve => {
    server.reloadFiles = (files) => resolve(files);
  });
}

// A single write right after `ready` can be missed under load (polling never reports it), so keep writing until it reloads
async function writeUntilReloaded(server, file) {
  let reloaded = waitForReload(server);
  let count = 0;
  let write = () => fs.writeFileSync(file, `b${count++} {}`);
  write();
  let timer = setInterval(write, 250);
  try {
    return await reloaded;
  } finally {
    clearInterval(timer);
  }
}

function waitForReady(watcher) {
  return new Promise(resolve => watcher.once("ready", resolve));
}

class FakeWatcher extends EventEmitter {
  added = [];
  closed = false;
  add(targets) {
    this.added.push(...targets);
  }
  async close() {
    this.closed = true;
  }
}

test("`watch` targets reload when `chokidar` is also passed", async () => {
  let dir = getTempDir();
  let file = path.join(dir, "style.css");
  fs.writeFileSync(file, "a {}");

  let external = new FakeWatcher();
  let server = new DevServer("test-server", "./test/stubs/", getOptions({
    watch: [dir],
    chokidar: external,
    chokidarOptions: { awaitWriteFinish: false, usePolling: true, interval: 50 },
  }));

  assert.notEqual(server.watcher, external);
  assert.deepEqual(external.added, []);

  await waitForReady(server.watcher);

  assert.deepEqual(await writeUntilReloaded(server, file), [file]);

  await server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Events from `chokidar` reload", async () => {
  let external = new FakeWatcher();
  let server = new DevServer("test-server", "./test/stubs/", getOptions({
    watch: [getTempDir()],
    chokidar: external,
  }));

  // Repeat calls do not double-register listeners
  server.getWatcher();
  assert.equal(external.listenerCount("change"), 1);

  for(let type of ["change", "add", "unlink"]) {
    let reloaded = waitForReload(server);
    external.emit(type, "_site/file.css");
    assert.deepEqual(await reloaded, ["_site/file.css"]);
  }

  await server.close();
  assert.ok(external.closed);
});

test("`chokidarOptions` apply to the server-owned watcher", async () => {
  let external = chokidar.watch([]);
  let server = new DevServer("test-server", "./test/stubs/", getOptions({
    watch: [getTempDir()],
    chokidar: external,
    chokidarOptions: { usePolling: true, interval: 42 },
  }));

  assert.equal(server.watcher.options.usePolling, true);
  assert.equal(server.watcher.options.interval, 42);
  assert.equal(server.watcher.options.ignoreInitial, true);
  assert.notEqual(external.options.interval, 42);

  await server.close();
});

test("`watchFiles` creates the server-owned watcher alongside `chokidar`", async () => {
  let external = new FakeWatcher();
  let server = new DevServer("test-server", "./test/stubs/", getOptions({
    chokidar: external,
  }));

  server.watchFiles([getTempDir()]);

  assert.notEqual(server.watcher, external);
  assert.deepEqual(external.added, []);

  await server.close();
});

test("Glob targets in `watch` reload", async () => {
  let dir = getTempDir();
  let file = path.join(dir, "style.css");
  fs.writeFileSync(file, "a {}");
  fs.writeFileSync(path.join(dir, "ignored.txt"), "a");

  let server = new DevServer("test-server", "./test/stubs/", getOptions({
    watch: [path.join(dir, "**/*.css")],
    chokidarOptions: { awaitWriteFinish: false, usePolling: true, interval: 50 },
  }));

  await waitForReady(server.watcher);
  fs.writeFileSync(path.join(dir, "ignored.txt"), "b");

  assert.deepEqual(await writeUntilReloaded(server, file), [file]);

  await server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
