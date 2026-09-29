import test from "ava";
import DevServer from "../server.js";
import { ReloadClient } from "../client/reload-client.js";

function getServer(options = {}) {
  let server = new DevServer("test-server", "./test/stubs/", {
    logger: {
      info: function() {},
      log: function() {},
      error: function() {},
    },
    ...options,
  });

  let notifications = [];
  server.sendUpdateNotification = (obj) => {
    notifications.push(obj);
  };

  return { server, notifications };
}

function getTemplates() {
  return [
    { url: "/", inputPath: "./index.njk", content: "Home" },
    { url: "/about/", inputPath: "./about.njk", content: "About" },
  ];
}

test("reload() filters templates by `files` without `build.outputs`", async (t) => {
  let { server, notifications } = getServer();

  server.reload({
    files: ["./about.njk"],
    build: { templates: getTemplates() },
  });

  t.deepEqual(notifications[0].build.templates.map(({ url }) => url), ["/about/"]);

  await server.close();
});

test("reload() sends all templates with `build.outputs`", async (t) => {
  let { server, notifications } = getServer();

  server.reload({
    files: ["./_data/site.json"],
    build: { outputs: true, templates: getTemplates() },
  });

  t.deepEqual(notifications[0].build.templates.map(({ url }) => url), ["/", "/about/"]);

  await server.close();
});

test("reload() sends no templates without `build.outputs` when domDiff is disabled", async (t) => {
  let { server, notifications } = getServer({ domDiff: false });

  server.reload({
    files: ["./about.njk"],
    build: { templates: getTemplates() },
  });

  t.deepEqual(notifications[0].build.templates, []);

  await server.close();
});

test("reload() sends templates without content with `build.outputs` when domDiff is disabled", async (t) => {
  let { server, notifications } = getServer({ domDiff: false });

  server.reload({
    files: ["./_data/site.json"],
    build: { outputs: true, templates: getTemplates() },
  });

  t.deepEqual(notifications[0].build.templates, [
    { url: "/", inputPath: "./index.njk", outputPath: undefined },
    { url: "/about/", inputPath: "./about.njk", outputPath: undefined },
  ]);

  await server.close();
});

test("Client: legacy build morphs a matching template from `files`", (t) => {
  let result = ReloadClient.getReloadAction(["./about.njk"], { templates: getTemplates() }, "/about/");
  t.is(result.action, "morph");
  t.deepEqual(result.templates.map(({ url }) => url), ["/about/"]);
});

test("Client: legacy build reloads when the template input is not in `files`", (t) => {
  let result = ReloadClient.getReloadAction(["./_data/site.json"], { templates: getTemplates() }, "/about/");
  t.deepEqual(result, { action: "reload", via: "ineligible domdiff" });
});

test("Client: outputs build morphs a matching template regardless of `files`", (t) => {
  let result = ReloadClient.getReloadAction(["./_data/site.json"], { outputs: true, templates: getTemplates() }, "/about/");
  t.is(result.action, "morph");
  t.deepEqual(result.templates.map(({ url }) => url), ["/about/"]);
});

test("Client: outputs build reloads for changed passthrough copy", (t) => {
  let result = ReloadClient.getReloadAction(["./img.png"], { outputs: true, templates: [], passthrough: ["/img.png"] }, "/about/");
  t.deepEqual(result, { action: "reload", via: "passthrough copy" });
});

test("Client: outputs build does nothing when this page did not change", (t) => {
  let result = ReloadClient.getReloadAction(["./index.njk"], { outputs: true, templates: getTemplates().slice(0, 1), passthrough: [] }, "/about/");
  t.deepEqual(result, { action: "none" });
});

test("Client: outputs build prefers morphing over passthrough reload", (t) => {
  let result = ReloadClient.getReloadAction([], { outputs: true, templates: getTemplates(), passthrough: ["/img.png"] }, "/");
  t.is(result.action, "morph");
});

test("Client: matches a template when the pathname ends in `index.html`", (t) => {
  let result = ReloadClient.getReloadAction([], { outputs: true, templates: getTemplates() }, "/about/index.html");
  t.deepEqual(result.templates.map(({ url }) => url), ["/about/"]);
});

test("Client: matches a template when the pathname has no trailing slash", (t) => {
  let result = ReloadClient.getReloadAction([], { outputs: true, templates: getTemplates() }, "/about");
  t.deepEqual(result.templates.map(({ url }) => url), ["/about/"]);
});

test("Client: matches a template with a percent-encoded pathname", (t) => {
  let templates = [{ url: "/café/", inputPath: "./café.njk", content: "Café" }];
  let result = ReloadClient.getReloadAction([], { outputs: true, templates }, "/caf%C3%A9/");
  t.deepEqual(result.templates.map(({ url }) => url), ["/café/"]);
});

test("Client: outputs build reloads a changed page when domDiff is disabled", (t) => {
  let templates = getTemplates().map(({ url, inputPath }) => ({ url, inputPath }));
  let result = ReloadClient.getReloadAction([], { outputs: true, templates }, "/about/");
  t.deepEqual(result, { action: "reload", via: "domdiff disabled" });
});

test("Client: outputs build does nothing for an untouched page when domDiff is disabled", (t) => {
  let templates = getTemplates().slice(0, 1).map(({ url, inputPath }) => ({ url, inputPath }));
  let result = ReloadClient.getReloadAction([], { outputs: true, templates, passthrough: [] }, "/about/");
  t.deepEqual(result, { action: "none" });
});

test("Client: normalizePath", (t) => {
  t.is(ReloadClient.normalizePath("/"), "/");
  t.is(ReloadClient.normalizePath("/index.html"), "/");
  t.is(ReloadClient.normalizePath("/about"), "/about");
  t.is(ReloadClient.normalizePath("/about/"), "/about");
  t.is(ReloadClient.normalizePath("/about/index.html"), "/about");
  t.is(ReloadClient.normalizePath("/caf%C3%A9/"), "/café");
  t.is(ReloadClient.normalizePath("/café/"), "/café");
  t.is(ReloadClient.normalizePath("/about.html"), "/about.html");
});

test("Client: getSocketUrl keeps pathPrefix from the script URL", (t) => {
  t.is(ReloadClient.getSocketUrl("http://localhost:8080/about/", "http://localhost:8080/.11ty/reload-client.js"), "ws://localhost:8080/");
  t.is(ReloadClient.getSocketUrl("https://example.test/prefix/about/", "https://example.test/prefix/.11ty/reload-client.js"), "wss://example.test/prefix/");
});

test("Client: getSocketUrl uses reloadPort", (t) => {
  t.is(ReloadClient.getSocketUrl("http://localhost:8080/prefix/", "http://localhost:8080/prefix/.11ty/reload-client.js?reloadPort=8081"), "ws://localhost:8081/prefix/");
});
