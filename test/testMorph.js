import test from "ava";
import { Window } from "happy-dom";
import { ReloadClient } from "../client/reload-client.js";

ReloadClient.IDIOMORPH_URL = import.meta.resolve("idiomorph");

const GLOBALS = ["window", "document", "DOMParser", "Node", "NodeFilter", "Element", "Document", "CSS", "customElements", "CustomEvent"];

// Loads `html` into a fresh global DOM; tests are serial since the client reads globals.
function load(html) {
  let window = new Window({ url: "http://localhost/" });
  window.document.write(html);
  for(let key of GLOBALS) {
    globalThis[key] = key === "window" ? window : window[key];
  }
  return window.document;
}

// Applies `html` as an in-place update to the current page (served as `previousContent`) and returns any full reloads it asked for.
async function morph(html, previousContent) {
  let reloads = [];
  let originalReload = ReloadClient.reload;
  ReloadClient.reload = ({ via }) => {
    reloads.push(via);
    return true;
  };

  try {
    await ReloadClient.reloadTypes.default([], {
      outputs: true,
      templates: [{ url: "/", inputPath: "./index.njk", content: html, previousContent }],
    });
  } finally {
    ReloadClient.reload = originalReload;
  }
  return reloads;
}

test.afterEach.always(async () => {
  await globalThis.window?.happyDOM.close();
  for(let key of GLOBALS) {
    delete globalThis[key];
  }
});

test.serial("Morph: syncs `<html>` attributes (#6)", async (t) => {
  let doc = load(`<!doctype html><html lang="en" class="old"><body><p>Before</p></body></html>`);
  let reloads = await morph(`<!doctype html><html lang="fr" data-theme="dark"><body><p>After</p></body></html>`);

  t.is(doc.documentElement.getAttribute("lang"), "fr");
  t.is(doc.documentElement.getAttribute("data-theme"), "dark");
  t.false(doc.documentElement.hasAttribute("class"));
  t.is(doc.querySelector("p").textContent, "After");
  t.deepEqual(reloads, []);
});

test.serial("Morph: works when the markup omits `</html>`", async (t) => {
  let doc = load(`<!doctype html><title>Before</title><p>Before`);
  await morph(`<!doctype html><title>After</title><p>After`);

  t.is(doc.title, "After");
  t.is(doc.querySelector("p").textContent, "After");
  t.is(doc.querySelectorAll("html, head, body").length, 3);
});

test.serial("Morph: keeps a `<link>` whose only change is a removed cache-busting param (#18)", async (t) => {
  let doc = load(`<!doctype html><head><link rel="stylesheet" href="/style.css?_bust=123"></head><body></body>`);
  let link = doc.querySelector("link");
  await morph(`<!doctype html><head><link rel="stylesheet" href="/style.css"></head><body></body>`);

  t.is(doc.querySelector("link"), link);
  t.is(link.getAttribute("href"), "/style.css?_bust=123");
});

test.serial("Morph: updates a `<link>` that gains or loses its `href`", async (t) => {
  let doc = load(`<!doctype html><head><link rel="preload" as="font" href="/font.woff2"></head><body></body>`);
  let reloads = await morph(`<!doctype html><head><link rel="preload" as="font"></head><body><p>After</p></body>`);
  t.false(doc.querySelector("link").hasAttribute("href"));
  t.is(doc.querySelector("p")?.textContent, "After");
  t.deepEqual(reloads, []);

  doc = load(`<!doctype html><head><link rel="preload" as="font"></head><body></body>`);
  await morph(`<!doctype html><head><link rel="preload" as="font" href="/font.woff2"></head><body><p>After</p></body>`);
  t.is(doc.querySelector("link").getAttribute("href"), "/font.woff2");
  t.is(doc.querySelector("p")?.textContent, "After");
});

test.serial("Morph: keeps stylesheets inserted via script", async (t) => {
  let doc = load(`<!doctype html><head><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/component.css"></head><body></body>`);
  await morph(`<!doctype html><head><link rel="stylesheet" href="/style.css"></head><body></body>`);

  t.deepEqual([...doc.querySelectorAll("link")].map(link => link.getAttribute("href")), ["/style.css", "/component.css"]);
});

test.serial("Morph: doesn’t update or remove `data-buildawesome-preserve` elements", async (t) => {
  let doc = load(`<!doctype html><body><div data-buildawesome-preserve>Client</div><p>Before</p><aside data-buildawesome-preserve>Client</aside></body>`);
  await morph(`<!doctype html><body><div data-buildawesome-preserve>Server</div><p>After</p></body>`);

  t.is(doc.querySelector("div").textContent, "Client");
  t.is(doc.querySelector("aside")?.textContent, "Client");
  t.is(doc.querySelector("p").textContent, "After");
});

test.serial("Morph: doesn’t update `inert` elements", async (t) => {
  let doc = load(`<!doctype html><body><div inert>Before</div></body>`);
  await morph(`<!doctype html><body><div inert>After</div></body>`);

  t.is(doc.querySelector("div").textContent, "Before");
});

test.serial("Morph: doesn’t update a focused input", async (t) => {
  let doc = load(`<!doctype html><body><input value="server"></body>`);
  let input = doc.querySelector("input");
  input.focus();
  input.value = "typing";
  await morph(`<!doctype html><body><input value="updated" class="new"></body>`);

  t.is(doc.querySelector("input"), input);
  t.is(input.value, "typing");
  t.false(input.hasAttribute("class"));
  t.is(doc.activeElement, input);
});

test.serial("Morph: moves elements with an `id` instead of recreating them", async (t) => {
  let doc = load(`<!doctype html><body><div><input id="first"></div><div><input id="second"></div></body>`);
  let first = doc.getElementById("first");
  await morph(`<!doctype html><body><div><input id="second"></div><div><input id="first"></div></body>`);

  t.is(doc.getElementById("first"), first);
  t.is(doc.querySelectorAll("input")[1], first);
  // Idiomorph’s temporary holding element is cleaned up
  t.is(doc.querySelectorAll("div[hidden]").length, 0);
});

test.serial("Morph: reloads when a `<script>` changes", async (t) => {
  load(`<!doctype html><body><script>let a = 1;</script></body>`);
  t.deepEqual(await morph(`<!doctype html><body><script>let a = 2;</script></body>`), ["<script> modified"]);
});

test.serial("Morph: doesn’t reload for an unchanged `<script>`", async (t) => {
  load(`<!doctype html><body><script>let a = 1;</script><p>Before</p></body>`);
  t.deepEqual(await morph(`<!doctype html><body><script>let a = 1;</script><p>After</p></body>`), []);
});

test.serial("Morph: reloads when a `<script>` is added, including inside a new element", async (t) => {
  load(`<!doctype html><body></body>`);
  t.deepEqual(await morph(`<!doctype html><body><script>let a = 1;</script></body>`), ["<script> added"]);

  load(`<!doctype html><body></body>`);
  t.deepEqual(await morph(`<!doctype html><body><div><script>let a = 1;</script></div></body>`), ["<script> added"]);
});

test.serial("Morph: updates an existing declarative shadow root in place (#90)", async (t) => {
  let doc = load(`<!doctype html><body><my-el><span>Before</span></my-el></body>`);
  let host = doc.querySelector("my-el");
  host.attachShadow({ mode: "open" }).innerHTML = `<p>Before</p>`;
  let shadowChild = host.shadowRoot.querySelector("p");

  await morph(`<!doctype html><body><my-el><template shadowrootmode="open"><p>After</p></template><span>After</span></my-el></body>`);

  t.is(doc.querySelector("my-el"), host);
  t.is(host.shadowRoot.innerHTML, `<p>After</p>`);
  t.is(host.shadowRoot.querySelector("p"), shadowChild);
  t.is(host.querySelector("template"), null);
  t.is(host.textContent, "After");
});

test.serial("Morph: attaches declarative shadow roots for new elements, including nested ones", async (t) => {
  let doc = load(`<!doctype html><body></body>`);
  await morph(`<!doctype html><body><div><outer-el><template shadowrootmode="open"><b>Outer</b><inner-el><template shadowrootmode="open"><i>Inner</i></template></inner-el></template></outer-el></div></body>`);

  let outer = doc.querySelector("outer-el");
  t.is(outer.querySelector("template"), null);
  t.is(outer.shadowRoot.querySelector("b").textContent, "Outer");
  t.is(outer.shadowRoot.querySelector("inner-el").shadowRoot.innerHTML, `<i>Inner</i>`);
});

// Loads `html` as served, lets `script` change it like a page script would, then applies `next`.
async function update(html, script, next) {
  let doc = load(html);
  script(doc);
  let reloads = await morph(next, html);
  return { doc, reloads };
}

test.serial("Three-way: keeps `<html>` attributes set by page scripts and applies source changes", async (t) => {
  let { doc } = await update(
    `<!doctype html><html lang="en"><body></body></html>`,
    (doc) => doc.documentElement.setAttribute("data-theme", "dark"),
    `<!doctype html><html lang="fr"><body></body></html>`,
  );

  t.is(doc.documentElement.getAttribute("data-theme"), "dark");
  t.is(doc.documentElement.getAttribute("lang"), "fr");
});

test.serial("Three-way: without the served HTML, page script changes are reset", async (t) => {
  let doc = load(`<!doctype html><html lang="en"><body></body></html>`);
  doc.documentElement.setAttribute("data-theme", "dark");
  await morph(`<!doctype html><html lang="fr"><body></body></html>`);

  t.false(doc.documentElement.hasAttribute("data-theme"));
});

test.serial("Three-way: keeps an attribute a page script changed unless the source changed it too", async (t) => {
  let html = (media) => `<!doctype html><head><link rel="stylesheet" href="/defer.css" media="${media}"></head><body></body>`;
  let loaded = (doc) => doc.querySelector("link").setAttribute("media", "all");

  let { doc } = await update(html("print"), loaded, `${html("print")}<p>Changed</p>`);
  t.is(doc.querySelector("link").getAttribute("media"), "all");

  ({ doc } = await update(html("print"), loaded, html("screen")));
  t.is(doc.querySelector("link").getAttribute("media"), "screen");
});

test.serial("Three-way: keeps nodes added by page scripts and removes nodes removed from the source", async (t) => {
  let { doc } = await update(
    `<!doctype html><body><nav><span class="source">Source</span><p>Removed</p></nav></body>`,
    (doc) => {
      let status = doc.createElement("span");
      status.className = "status";
      doc.querySelector("nav").append(status);
    },
    `<!doctype html><body><nav><span class="source">Source</span></nav></body>`,
  );

  t.is(doc.querySelector(".status")?.parentNode, doc.querySelector("nav"));
  t.is(doc.querySelector(".source")?.textContent, "Source");
  t.is(doc.querySelector("p"), null);
});

test.serial("Three-way: doesn’t re-add nodes a page script removed", async (t) => {
  let { doc } = await update(
    `<!doctype html><body><div class="banner">Dismiss me</div><p>Before</p></body>`,
    (doc) => doc.querySelector(".banner").remove(),
    `<!doctype html><body><div class="banner">Dismiss me</div><p>After</p></body>`,
  );

  t.is(doc.querySelector(".banner"), null);
  t.is(doc.querySelector("p").textContent, "After");
});

test.serial("Three-way: keeps text a page script changed unless the source changed it too", async (t) => {
  let html = (time, label) => `<!doctype html><body><time>${time}</time><p>${label}</p></body>`;
  let { doc } = await update(
    html("2026-10-29", "Before"),
    (doc) => doc.querySelector("time").textContent = "2 days ago",
    html("2026-10-29", "After"),
  );

  t.is(doc.querySelector("time").textContent, "2 days ago");
  t.is(doc.querySelector("p").textContent, "After");

  ({ doc } = await update(
    html("2026-10-29", "Before"),
    (doc) => doc.querySelector("time").textContent = "2 days ago",
    html("2026-10-30", "Before"),
  ));
  t.is(doc.querySelector("time").textContent, "2026-10-30");
});

test.serial("Three-way: keeps form state a user changed", async (t) => {
  let { doc } = await update(
    `<!doctype html><body><input type="checkbox"><p>Before</p></body>`,
    (doc) => doc.querySelector("input").checked = true,
    `<!doctype html><body><input type="checkbox"><p>After</p></body>`,
  );

  t.true(doc.querySelector("input").checked);
  t.is(doc.querySelector("p").textContent, "After");
});

// Behaves like a Web Awesome (Lit) component: renders its own shadow root and reflects properties to attributes.
function defineComponent(window) {
  window.customElements.define("wa-like", class extends window.HTMLElement {
    static observedAttributes = ["variant"];
    constructor() {
      super();
      this.attachShadow({ mode: "open", delegatesFocus: true }).innerHTML = `<button part="base"><slot></slot></button>`;
    }
    connectedCallback() {
      if(!this.hasAttribute("variant")) {
        this.setAttribute("variant", "neutral");
      }
    }
    attributeChangedCallback(name, oldValue, value) {
      this.shadowRoot.querySelector("button").className = value;
    }
  });
}

test.serial("Three-way: works with script-rendered components like Web Awesome", async (t) => {
  let html = (variant, label) => `<!doctype html><body><wa-like${variant ? ` variant="${variant}"` : ""}>${label}</wa-like><wa-like id="other">Other</wa-like></body>`;
  let host, button;
  let { doc } = await update(html("", "Before"), (doc) => {
    defineComponent(doc.defaultView);
    host = doc.querySelector("wa-like");
    button = host.shadowRoot.querySelector("button");
    host.setAttribute("open", ""); // Reflected from user interaction
  }, html("", "After"));

  t.is(doc.querySelector("wa-like"), host);
  t.is(host.shadowRoot.querySelector("button"), button, "Shadow root rendered by the component is left alone");
  t.is(host.getAttribute("variant"), "neutral");
  t.true(host.hasAttribute("open"));
  t.is(host.textContent, "After");

  ({ doc } = await update(html("", "Before"), (doc) => {
    defineComponent(doc.defaultView);
    host = doc.querySelector("wa-like");
  }, `${html("brand", "Before")}<wa-like class="added">Added</wa-like>`));

  t.is(host.getAttribute("variant"), "brand");
  t.is(host.shadowRoot.querySelector("button").className, "brand");
  let added = doc.querySelector(".added");
  t.is(added.getAttribute("variant"), "neutral", "New components upgrade");
  t.truthy(added.shadowRoot?.querySelector("slot"));
});
