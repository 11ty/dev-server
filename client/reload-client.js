class Util {
  static pad(num, digits = 2) {
    let zeroes = "0".repeat(digits);
    return `${zeroes}${num}`.slice(-1 * digits);
  }

  static log(...messages) {
    Util.output("log", ...messages);
  }
  static error(message, error) {
    Util.output("error", message, error);
  }
  static output(type, ...messages) {
    let now = new Date();
    let date = `${Util.pad(now.getUTCHours())}:${Util.pad(
      now.getUTCMinutes()
    )}:${Util.pad(now.getUTCSeconds())}.${Util.pad(
      now.getUTCMilliseconds(),
      3
    )}`;
    console[type](`[11ty][${date} UTC]`, ...messages);
  }

  /** @returns {NodeListOf<HTMLLinkElement>} */
  static getStylesheetLinks() {
    return document.querySelectorAll(`link[rel="stylesheet"]`);
  }

  static capitalize(word) {
    return word.substr(0, 1).toUpperCase() + word.substr(1);
  }

  // Declarative Shadow DOM https://github.com/11ty/eleventy-dev-server/issues/90
  static isShadowRootTemplate(node) {
    return node?.nodeName === "TEMPLATE" && node.hasAttribute("shadowrootmode");
  }

  // `DOMParser` leaves `<template shadowrootmode>` inert, so morph (or attach) the shadow root it declares.
  static morphShadowRoot(host, template, Idiomorph, options) {
    let root = host.shadowRoot;
    if(!root) {
      try {
        root = host.attachShadow({ mode: template.getAttribute("shadowrootmode") });
      } catch(e) {
        // Closed shadow roots can’t be reached
        return;
      }
    }
    Idiomorph.morph(root, template.content, { ...options, morphStyle: "innerHTML" });
  }

  static getMorphOptions(Idiomorph) {
    let options = {
      // Match `<head>` children in place like `<body>`; the default merge appends new nodes, which reorders stylesheets
      head: { style: "morph" },
      callbacks: {
        beforeNodeAdded: (node) => {
          return !Util.isShadowRootTemplate(node);
        },
        afterNodeAdded: (node) => {
          if(node.nodeType !== Node.ELEMENT_NODE) {
            return;
          }

          if(node.nodeName === "SCRIPT" || node.querySelector("script")) {
            ReloadClient.reload({ via: "<script> added"});
          }

          for(let template of node.querySelectorAll("template[shadowrootmode]")) {
            Util.morphShadowRoot(template.parentElement, template, Idiomorph, options);
            template.remove();
          }
        },
        beforeNodeRemoved: (node) => {
          // Don’t discard stylesheets inserted via script! (e.g. Web Awesome)
          // TODO maybe more defensive?
          if((node?.tagName || "").toLowerCase() === "link") {
            return false;
          }

          if(node?.hasAttribute?.(ReloadClient.PRESERVE_ATTR)) {
            return false;
          }
        },
        beforeNodeMorphed: (fromEl, toEl) => {
          if(fromEl.nodeType !== Node.ELEMENT_NODE) {
            return true;
          }

          if(fromEl.hasAttribute("inert") || fromEl.hasAttribute(ReloadClient.PRESERVE_ATTR)) {
            return false;
          }

          if(fromEl.matches(':is(input,textarea,select):focus')) {
            return false;
          }

          if (fromEl.nodeName === "SCRIPT" && toEl.nodeName === "SCRIPT") {
            if(toEl.innerHTML !== fromEl.innerHTML) {
              ReloadClient.reload({ via: "<script> modified"});
            }

            return false;
          }

          if(Util.isLinkNodeMatch(fromEl, toEl)) {
            return false;
          }

          let template = [...toEl.children].find(child => Util.isShadowRootTemplate(child));
          if(template) {
            Util.morphShadowRoot(fromEl, template, Idiomorph, options);
          }

          return true;
        },
      },
    };
    return options;
  }

  static isLinkNodeMatch(from, to) {
    // Issue #18 https://github.com/11ty/eleventy-dev-server/issues/18
    // Don’t update a <link> if the _11ty searchParam is the only thing that’s different
    if(from.tagName !== "LINK" || to.tagName !== "LINK") {
      return false;
    }

    let fromClone = from.cloneNode();
    let toClone = to.cloneNode();

    fromClone.removeAttribute("href");
    toClone.removeAttribute("href");

    // Speed-up trick from morphdom docs
    // https://dom.spec.whatwg.org/#concept-node-equals

    // if all other attributes besides href match
    if(!fromClone.isEqualNode(toClone)) {
      return false;
    }

    let oldHref = from.getAttribute("href");
    let newHref = to.getAttribute("href");
    if(oldHref === null || newHref === null) {
      return false;
    }

    // Resolved against this page, since the parsed document may not share its base URL
    let oldUrl = URL.parse(oldHref, document.baseURI);
    let newUrl = URL.parse(newHref, document.baseURI);
    if(!oldUrl || !newUrl) {
      return false;
    }

    // The morph would otherwise force href="style.css?_11ty" => href="style.css"
    let paramName = ReloadClient.CACHE_BUST_PARAM;
    let isErasing = oldUrl.searchParams.has(paramName) && !newUrl.searchParams.has(paramName);
    if(!isErasing) {
      // not a match if _11ty has a new value (not being erased)
      return false;
    }

    oldUrl.searchParams.set(paramName, "");
    newUrl.searchParams.set(paramName, "");

    // is a match if erasing and the rest of the href matches too
    return oldUrl.toString() === newUrl.toString();
  }

  // https://github.com/patrick-steele-idem/morphdom/issues/178#issuecomment-652562769
  static runScript(source, target) {
    let script = document.createElement('script');

    // copy over the attributes
    for(let attr of [...source.attributes]) {
      script.setAttribute(attr.nodeName ,attr.nodeValue);
    }

    script.innerHTML = source.innerHTML;
    (target || source).replaceWith(script);
  }

  static fullPageReload(options = {}) {
    let { via } = options;
    Util.log(`Full page reload (via: ${via})`);

    if("navigation" in window) {
      navigation.navigate(location.href);
    } else {
      location.href = location.href;
    }
  }
}

export class ReloadClient {
  #socket;
  #ack = [];
  #ready = false; // swap to Promise.withResolvers
  #buildId; // specific to one single core build run

  static RELOAD_ENABLED = true;
  static PORT_PARAM = "reloadPort";
  static CACHE_BUST_PARAM = "_bust";
  static TAG_NAME = "reload-client";
  static RECONNECT_INTERVAL = 2000; // ms
  static MAX_RECONNECT_INTERVAL = 5000; // ms, so a restarted server is found quickly without a focus or visibility change
  static EVENT_PREFIXES = ["eleventy.", "buildawesome."];
  static PRESERVE_ATTR = "data-buildawesome-preserve";
  static BEFORE_RELOAD_TIMEOUT = 1000; // ms
  /** @internal Relative to this script so the `.11ty` folder name can change (tests point it at the package). */
  static IDIOMORPH_URL = "./idiomorph.js";

  static getEventName(type = "") {
    let prefix = ReloadClient.EVENT_PREFIXES.find(prefix => type.startsWith(prefix));
    return prefix ? type.slice(prefix.length) : undefined;
  }

  static isCustomElement(node) {
    return customElements.get(node.tagName.toLowerCase())
  }

  setReloadEnabled(enabled) {
    ReloadClient.RELOAD_ENABLED = Boolean(enabled);
  }

  // The page’s host (or `reloadPort`), at the path above this script’s folder so `pathPrefix` is kept, with `?page=` so the server can scope reloads.
  static getSocketUrl(documentHref, scriptHref) {
    let scriptUrl = new URL(scriptHref);
    let url = new URL(new URL("..", scriptUrl).pathname, documentHref);
    url.searchParams.set("page", new URL(documentHref).pathname);

    let reloadPort = scriptUrl.searchParams.get(ReloadClient.PORT_PARAM);
    if(reloadPort) {
      url.port = reloadPort;
    }

    // works with http (ws) and https (wss)
    url.protocol = url.protocol.replace("http", "ws");
    return url.toString();
  }

  static reload(options = {}) {
    if(!this.RELOAD_ENABLED) {
      return false;
    }
    Util.fullPageReload(options);
    return true;
  }

  // Treats `/about`, `/about/`, `/about/index.html`, and percent-encoded forms as the same page.
  static normalizePath(path = "") {
    let { pathname } = new URL(path, "http://localhost/");
    try {
      pathname = decodeURI(pathname);
    } catch(e) {
      // Keep malformed URIs encoded
    }

    if(pathname.endsWith("/index.html")) {
      pathname = pathname.slice(0, -"index.html".length);
    }
    if(pathname.length > 1 && pathname.endsWith("/")) {
      pathname = pathname.slice(0, -1);
    }
    return pathname;
  }

  // Returns `{ action: "morph", templates }`, `{ action: "reload", via }`, or `{ action: "none" }` for the default reload type.
  static getReloadAction(files, build = {}, pathname = "") {
    let normalizedPathname = this.normalizePath(pathname);
    let templates = (build?.templates || []).filter(({url, inputPath}) => {
      // `build.outputs` (newer Eleventy) means templates are already filtered to changed output
      return this.normalizePath(url) === normalizedPathname && (build?.outputs || (files || []).includes(inputPath));
    });

    if(templates.length > 0) {
      // Templates without content mean DOM diffing is disabled on the server
      if(templates.some(({ content }) => typeof content !== "string")) {
        return { action: "reload", via: "domdiff disabled" };
      }

      return { action: "morph", templates };
    }

    if(!build?.outputs) {
      return { action: "reload", via: "ineligible domdiff" };
    }

    if(build.passthrough?.length > 0) {
      return { action: "reload", via: "passthrough copy" };
    }

    return { action: "none" };
  }

  // Lets page scripts prepare for an in-place update, waiting at most `BEFORE_RELOAD_TIMEOUT` for their promises.
  static async dispatchBeforeReload(buildId) {
    let promises = [];
    document.dispatchEvent(new CustomEvent("buildawesome:beforereload", {
      detail: {
        buildId,
        waitUntil: (promise) => promises.push(promise),
      },
    }));

    if(promises.length > 0) {
      let timer;
      await Promise.race([
        Promise.allSettled(promises),
        new Promise(resolve => timer = setTimeout(resolve, ReloadClient.BEFORE_RELOAD_TIMEOUT)),
      ]);
      clearTimeout(timer);
    }
  }

  // Returns a `:nth-of-type` path from the nearest ancestor-or-self with an `id` (or from `<html>`).
  static getFocusPath(el, doc = document) {
    let steps = [];
    let node = el;
    while(node && node !== doc.documentElement && !node.id) {
      let parent = node.parentElement;
      if(!parent) {
        return;
      }
      let index = [...parent.children].filter(child => child.tagName === node.tagName).indexOf(node) + 1;
      steps.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${index})`);
      node = parent;
    }
    if(!node) {
      return;
    }
    return { id: node.id || undefined, selector: steps.join(" > ") || undefined };
  }

  /** @param {{ id?: string, selector?: string }} path */
  static findByFocusPath({ id, selector }, doc = document) {
    let root = id ? doc.getElementById(id) : doc.documentElement;
    if(!root || !selector) {
      return root;
    }
    return root.querySelector(`:scope > ${selector}`);
  }

  static isTextControl(el) {
    return ["INPUT", "TEXTAREA"].includes(el?.tagName);
  }

  // Records what has focus so it can be restored after the morph replaces it.
  static captureFocus(doc = document) {
    let element = /** @type {any} */ (doc.activeElement);
    if(!element || element === doc.body) {
      return;
    }

    /** @type {Record<string, any>} */
    let state = {
      element,
      tagName: element.tagName,
      path: this.getFocusPath(element, doc),
      // Survives the structural changes that make the morph replace an element.
      tagIndex: [...doc.getElementsByTagName(element.localName)].indexOf(element),
      // Inner shadow DOM nodes have no path; only the host is found again.
      shadowElement: element.shadowRoot?.activeElement || undefined,
    };

    if(this.isTextControl(element) && typeof element.selectionStart === "number") {
      let { selectionStart, selectionEnd, selectionDirection } = element;
      state.selection = { selectionStart, selectionEnd, selectionDirection };
    }

    return state;
  }

  static isFocusLost(doc = document) {
    return !doc.activeElement || doc.activeElement === doc.body;
  }

  static focusElement(el) {
    try {
      el.focus({ preventScroll: true });
    } catch(e) {
      // Custom elements may throw before their first render (e.g. Web Awesome’s `focus()` uses a not-yet-rendered input)
    }
  }

  // Refocuses the recorded element (or its same-tag replacement) unless something else has focus now.
  static async restoreFocus(state, doc = document) {
    if(!state || !this.isFocusLost(doc)) {
      return;
    }

    let target = state.element;
    if(!target.isConnected) {
      target = state.path ? this.findByFocusPath(state.path, doc) : undefined;
      if(target?.tagName !== state.tagName) {
        target = doc.getElementsByTagName(state.element.localName)[state.tagIndex];
      }
      if(target?.tagName !== state.tagName) {
        return;
      }
    }

    let focusTarget = target === state.element && state.shadowElement?.isConnected ? state.shadowElement : target;
    this.focusElement(focusTarget);

    // A replaced custom element may need to render before it can take focus.
    let registry = (doc.defaultView || globalThis).customElements;
    if(this.isFocusLost(doc) && registry?.get(target.localName)) {
      await (target.updateComplete || new Promise(resolve => setTimeout(resolve)));
      if(!this.isFocusLost(doc) || !target.isConnected) {
        return;
      }
      this.focusElement(focusTarget);
    }

    if(state.selection && this.isTextControl(target)) {
      let { selectionStart, selectionEnd, selectionDirection } = state.selection;
      try {
        target.setSelectionRange(selectionStart, selectionEnd, selectionDirection);
      } catch(e) {
        // Some input types don’t support selection
      }
    }
  }

  static reloadTypes = {
    css: (files, build = {}) => {
      // Initiate a full page refresh if a CSS change is made but does match any stylesheet url
      // `build.stylesheets` available in Eleventy v3.0.1-alpha.5+
      if(Array.isArray(build.stylesheets)) {
        let match = false;
        for (let link of Util.getStylesheetLinks()) {
          if (link.href) {
            let url = new URL(link.href);
            if(build.stylesheets.includes(url.pathname)) {
              match = true;
            }
          }
        }

        if(!match) {
          return this.reload({ via: "css" });
        }
      }

      for (let link of Util.getStylesheetLinks()) {
        if (link.href) {
          let url = new URL(link.href);
          url.searchParams.set(this.CACHE_BUST_PARAM, String(Date.now()));
          link.href = url.toString();
        }
      }

      Util.log(`CSS updated without page reload.`);
      return true;
    },
    default: async (files, build = {}) => {
      let morphed = false;
      let { action, via, templates: domdiffTemplates } = this.getReloadAction(files, build, document.location.pathname);

      if(action === "none") {
        Util.log(`No changes to this page.`);
        return false;
      }

      if(action === "reload") {
        return this.reload({ via });
      }

      // Temporary
      if(ReloadClient.RELOAD_ENABLED === false) {
        return false;
      }

      try {
        const { Idiomorph } = await import(ReloadClient.IDIOMORPH_URL);

        for (let {url, inputPath, content} of domdiffTemplates) {
          // Notable limitation: this won’t re-run script elements or JavaScript page lifecycle events (load/DOMContentLoaded)
          morphed = true;

          let focusState = ReloadClient.captureFocus();

          // Morphing from a parsed `<html>` (not a string) keeps its attributes in sync and allows an omitted `</html>`
          let { documentElement } = new DOMParser().parseFromString(content, "text/html");
          Idiomorph.morph(document.documentElement, documentElement, Util.getMorphOptions(Idiomorph));

          await ReloadClient.restoreFocus(focusState);
          Util.log(`HTML delta applied without page reload.`);
        }
      } catch(e) {
        Util.error( "Idiomorph error", e );
      }

      if (!morphed) {
        return this.reload({ via: "no domdiff content received" });
      }

      return true;
    }
  }

  constructor() {
    this.reconnectInterval = ReloadClient.RECONNECT_INTERVAL;
    this.connectionMessageShown = false;
    this.reconnectEventCallback = this.reconnect.bind(this);

    // bfcache restores resume with a closed socket: reconnect now, don’t wait on the timer.
    window.addEventListener("pageshow", (event) => {
      if(event.persisted && this.#socket?.readyState !== WebSocket.OPEN) {
        this.reconnect(event);
      }
    });
  }

  get socket() {
    if(this.#socket) {
      return this.#socket;
    }

    this.#socket = new WebSocket(ReloadClient.getSocketUrl(document.location.href, import.meta.url));

    return this.#socket;
  }

  init(options = {}) {
    if (!("WebSocket" in window)) {
      return;
    }

    this.socket.addEventListener("message", async (event) => {
      try {
        let data = JSON.parse(event.data);
        // Util.log( JSON.stringify(data, null, 2) );

        let type = ReloadClient.getEventName(data.type);

        if (type === "reload") {
          await this.onreload(data);
        } else if (type === "msg") {
          Util.log(`${data.message}`);
        } else if (type === "error") {
          // Log Eleventy build errors
          // Extra parsing for Node Error objects
          let e = JSON.parse(data.error);
          Util.error(`Build error: ${e.message}`, e);
        } else if (type === "status") {
          // A reconnect may have missed builds, but usually hasn’t—only reload if the
          // server moved on. No `buildId` (older server) reloads unconditionally, as before.
          if (data.status === "connected" && options.mode === "reconnect") {
            if(!this.#buildId || !data.buildId || this.#buildId !== data.buildId) {
              // This page is going away, so the reloaded page reports the connection
              if(ReloadClient.reload({ via: "reconnect"})) {
                return;
              }
            } else {
              Util.log(`Reconnected without page reload.`);
            }
          }

          if(data.status === "connected") {
            this.#buildId = data.buildId;
            // With multiple windows, only show one connection message
            if(!this.connectionMessageShown) {
              Util.log(Util.capitalize(data.status));
            }

            this.connectionMessageShown = true;
            this.#ready = true;
            this.reconnectInterval = ReloadClient.RECONNECT_INTERVAL;
          } else {
            if(data.status === "disconnected") {
              this.addReconnectListeners();
            }

            Util.log(Util.capitalize(data.status));
          }
        } else if(type === "edit") {
          // Forward server replies only (not requests echoed from other windows)
          if("ok" in data && !data.edits) {
            document.dispatchEvent(new CustomEvent("buildawesome:edit", { detail: data }));
          }
        } else if(type === "ack") {
          // acknowledge that a message has been received for removal on client
          for(let ackFn of this.#ack) {
            if(typeof ackFn) {
              ackFn(data.id);
            }
          }
        } else {
          Util.log("Unknown event type", data);
        }
      } catch (e) {
        Util.error(`Error parsing ${event.data}: ${e.message}`, e);
      }
    });

    this.socket.addEventListener("open", () => {
      // no reconnection when the connect is already open
      this.removeReconnectListeners();
    });

    this.socket.addEventListener("close", () => {
      this.connectionMessageShown = false;
      this.addReconnectListeners(150);
    });
  }

  reconnect(e) {
    // Only returning to the page should reconnect, not leaving it (#147)
    if(e?.type === "visibilitychange" && document.visibilityState !== "visible") {
      return;
    }

    if(!e) {
      // incremental backoff if via setTimeout
      this.reconnectInterval = Math.min(this.reconnectInterval * 2, ReloadClient.MAX_RECONNECT_INTERVAL);
    }

    Util.log( "Reconnecting…" );
    this.#socket = undefined;
    this.init({ mode: "reconnect" });
  }

  async onreload({ subtype, files, build, buildId }) {
    this.#buildId = buildId;

    // A page this build moved (e.g. its permalink changed): go where it is now, not back to where it was
    let redirect = (build?.redirects || []).find(({ from }) => from === document.location.pathname);
    if(redirect) {
      document.location.assign(redirect.to);
      return;
    }

    if(!ReloadClient.reloadTypes[subtype]) {
      subtype = "default";
    }

    if(subtype === "default" && build?.outputs && ReloadClient.getReloadAction(files, build, document.location.pathname).action === "morph") {
      await ReloadClient.dispatchBeforeReload(buildId);
    }

    let changed = Boolean(await ReloadClient.reloadTypes[subtype](files, build));

    // In-place updates skip page reloads, so let page scripts know a rebuild was applied (`changed` is false when this page was untouched)
    document.dispatchEvent(new CustomEvent("buildawesome:reload", { detail: { buildId, changed } }));
  }

  addReconnectListeners(delay = 0) {
    this.removeReconnectListeners();

    setTimeout(() => {
      window.addEventListener("visibilitychange", this.reconnectEventCallback);
      clearTimeout(this.reconnectTimer);

      // TODO maximum 10 reconnect tries
      this.reconnectTimer = setTimeout(this.reconnectEventCallback, this.reconnectInterval);
    }, delay);
  }

  removeReconnectListeners() {
    clearTimeout(this.reconnectTimer);
    window.removeEventListener("visibilitychange", this.reconnectEventCallback);
  }

  sendToServer(type, data) {
    if(!this.#ready) {
      throw new Error("Server is not yet ready.");
    }

    const id = crypto.randomUUID();

    // used to return send(), but send() returns undefined
    this.socket.send(JSON.stringify({
      id,
      type,
      data,
      timestamp: Date.now(),
    }));

    return { id };
  }

  onAcknowledge(callback) {
    this.#ack.push(callback);
  }
}

// Skipped outside the browser (e.g. when imported by tests)
if(typeof window !== "undefined") {
  let reloader = new ReloadClient();
  reloader.init();

  // Backwards compat
  /** @type {any} */ (window).EleventyReload = reloader;
  /** @type {any} */ (window).BuildAwesomeReload = reloader;
}