const test = require("ava");
const fs = require("node:fs");
const path = require("node:path");
const EleventyDevServer = require("../");

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

  t.deepEqual(reloaded, [`${dir.split(path.sep).join("/")}/style.css`]);

  await server.close();
});
