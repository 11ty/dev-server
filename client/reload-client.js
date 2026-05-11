class Util {
  static pad(num, digits = 2) {
    let zeroes = new Array(digits + 1).join(0);
    return `${zeroes}${num}`.slice(-1 * digits);
  }

  static log(message) {
    Util.output("log", message);
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

  static capitalize(word) {
    return word.substr(0, 1).toUpperCase() + word.substr(1);
  }

  static matchRootAttributes(htmlContent) {
    // Workaround for morphdom bug with attributes on <html> https://github.com/11ty/eleventy-dev-server/issues/6
    // Note also `childrenOnly: true` above
    const parser = new DOMParser();
    let parsed = parser.parseFromString(htmlContent, "text/html");
    let parsedDoc = parsed.documentElement;
    let newAttrs = parsedDoc.getAttributeNames();

    let docEl = document.documentElement;
    // Remove old
    let removedAttrs = docEl.getAttributeNames().filter(name => !newAttrs.includes(name));
    for(let attr of removedAttrs) {
      docEl.removeAttribute(attr);
    }

    // Add new
    for(let attr of newAttrs) {
      docEl.setAttribute(attr, parsedDoc.getAttribute(attr));
    }
  }

  static isEleventyLinkNodeMatch(from, to) {
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

    let oldUrl = new URL(from.href);
    let newUrl = new URL(to.href);

    // morphdom wants to force href="style.css?_11ty" => href="style.css"
    let paramName = EleventyReload.QUERY_PARAM;
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
    // window.location.reload();

    if("navigation" in window) {
      navigation.navigate(location.href);
    } else {
      location.href = location.href;
    }
  }

  static highlightNode(el, color = '#00a776', duration = 600) {
    if(!el || el.nodeType !== Node.ELEMENT_NODE || typeof el.animate !== "function") {
      return;
    }
    el.animate(
      [
        { outline: `.15em solid var(--eleventy-reload-highlight, ${color})`, outlineOffset: "2px", offset: 0 },
        { outline: ".15em solid transparent", outlineOffset: "2px", offset: 1 }
      ],
      { duration, easing: 'ease-out', fill: 'none' }
    );
  }
}

class EleventyReload {
  #socket;
  #ack = [];
  #ready = false; // swap to Promise.withResolvers

  static RELOAD_ENABLED = true;
  static QUERY_PARAM = "_11ty";

  static isCustomElement(node) {
    return customElements.get(node.tagName.toLowerCase())
  }

  setReloadEnabled(enabled) {
    EleventyReload.RELOAD_ENABLED = Boolean(enabled);
  }

  static reload(options = {}) {
    if(!this.RELOAD_ENABLED) {
      return;
    }
    Util.fullPageReload(options);
  }

  static reloadTypes = {
    css: (files, build = {}) => {
      // Initiate a full page refresh if a CSS change is made but does match any stylesheet url
      // `build.stylesheets` available in Eleventy v3.0.1-alpha.5+
      if(Array.isArray(build.stylesheets)) {
        let match = false;
        for (let link of document.querySelectorAll(`link[rel="stylesheet"]`)) {
          if (link.href) {
            let url = new URL(link.href);
            if(build.stylesheets.includes(url.pathname)) {
              match = true;
            }
          }
        }

        if(!match) {
          this.reload({ via: "css" });
          return;
        }
      }

      for (let link of document.querySelectorAll(`link[rel="stylesheet"]`)) {
        if (link.href) {
          let url = new URL(link.href);
          url.searchParams.set(this.QUERY_PARAM, Date.now());
          link.href = url.toString();
        }
      }

      Util.log(`CSS updated without page reload.`);
    },
    default: async (files, build = {}) => {
      let morphed = false;
      let domdiffTemplates = (build?.templates || []).filter(({url, inputPath}) => {
        return url === document.location.pathname && (files || []).includes(inputPath);
      });

      // Not eligible for domDiff
      if(domdiffTemplates.length === 0) {
        this.reload({ via: "ineligible domdiff"});
        return;
      }

      // Temporary
      if(EleventyReload.RELOAD_ENABLED === false) {
        return;
      }

      try {
        // Important: using `./` allows the `.11ty` folder name to be changed
        const { default: morphdom } = await import(`./morphdom.js`);

        for (let {url, inputPath, content} of domdiffTemplates) {
          // Notable limitation: this won’t re-run script elements or JavaScript page lifecycle events (load/DOMContentLoaded)
          morphed = true;

          morphdom(document.documentElement, content, {
            childrenOnly: false,
            onBeforeNodeDiscarded: function(node) {
              // Don’t discard stylesheets inserted via script! (e.g. Web Awesome)
              // TODO maybe more defensive?
              if((node?.tagName || "").toLowerCase() === "link") {
                return false;
              }
            },
            onBeforeElUpdated: function (fromEl, toEl) {
              if(fromEl.hasAttribute("inert")) {
                Util.highlightNode(fromEl);
                return false;
              }

              if(fromEl.matches(':is(input,textarea,select):focus')) {
                Util.highlightNode(fromEl);
                return false;
              }

              if (fromEl.nodeName === "SCRIPT" && toEl.nodeName === "SCRIPT") {
                if(toEl.innerHTML !== fromEl.innerHTML) {
                  EleventyReload.reload({ via: "<script> modified"});
                }

                return false;
              }

              if(Util.isEleventyLinkNodeMatch(fromEl, toEl)) {
                return false;
              }

              return true;
            },
            addChild: function(parent, child) {
              // Declarative Shadow DOM https://github.com/11ty/eleventy-dev-server/issues/90
              if(child.nodeName === "TEMPLATE" && child.hasAttribute("shadowrootmode")) {
                let root = parent.shadowRoot;
                if(root) {
                  // remove all shadow root children
                  while(root.firstChild) {
                    root.removeChild(root.firstChild);
                  }
                }
                for(let newChild of child.content.childNodes) {
                  root.appendChild(newChild);
                }
              } else {
                parent.appendChild(child);
              }

              Util.highlightNode(child);
            },
            onNodeAdded: function (node) {
              if (node.nodeName === 'SCRIPT') {
                EleventyReload.reload({ via: "<script> added"});
              }
            },
            // Removed an `onElUpdated` bit that reattached custom elements (to retrigger connectedCallback methods?)
          });

          Util.matchRootAttributes(content);
          Util.log(`HTML delta applied without page reload.`);
        }
      } catch(e) {
        Util.error( "Morphdom error", e );
      }

      if (!morphed) {
        this.reload({ via: "no domdiff content received" });
      }
    }
  }

  constructor() {
    this.connectionMessageShown = false;
    this.reconnectEventCallback = this.reconnect.bind(this);
  }

  get socket() {
    if(this.#socket) {
      return this.#socket;
    }

    let documentUrl = new URL(document.location.href);

    let reloadPort = new URL(import.meta.url).searchParams.get("reloadPort");
    if(reloadPort) {
      documentUrl.port = reloadPort;
    }

    let { protocol, host } = documentUrl;

    // works with http (ws) and https (wss)
    let websocketProtocol = protocol.replace("http", "ws");

    this.#socket = new WebSocket(`${websocketProtocol}//${host}`);

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

        let { type } = data;

        if (type === "eleventy.reload") {
          await this.onreload(data);
        } else if (type === "eleventy.msg") {
          Util.log(`${data.message}`);
        } else if (type === "eleventy.error") {
          // Log Eleventy build errors
          // Extra parsing for Node Error objects
          let e = JSON.parse(data.error);
          Util.error(`Build error: ${e.message}`, e);
        } else if (type === "eleventy.status") {
          // Full page reload on initial reconnect
          if (data.status === "connected" && options.mode === "reconnect") {
            EleventyReload.reload({ via: "reconnect"});
          }

          if(data.status === "connected") {
            // With multiple windows, only show one connection message
            if(!this.isConnected) {
              Util.log(Util.capitalize(data.status));
            }

            this.connectionMessageShown = true;
            this.#ready = true;
          } else {
            if(data.status === "disconnected") {
              this.addReconnectListeners();
            }

            Util.log(Util.capitalize(data.status));
          }
        } else if(type === "eleventy.edit") {
          // TODO edits received from other clients
        } else if(type === "eleventy.ack") {
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

  reconnect() {
    Util.log( "Reconnecting…" );
    this.#socket = undefined;
    this.init({ mode: "reconnect" });
  }

  async onreload({ subtype, files, build }) {
    if(!EleventyReload.reloadTypes[subtype]) {
      subtype = "default";
    }

    await EleventyReload.reloadTypes[subtype](files, build);
  }

  addReconnectListeners(delay = 0) {
    this.removeReconnectListeners();

    setTimeout(() => {
      window.addEventListener("focus", this.reconnectEventCallback);
      window.addEventListener("visibilitychange", this.reconnectEventCallback);
      clearInterval(this.reconnectInterval);

      // TODO incremental backoff and maximum 10 reconnect tries
      this.reconnectInterval = setInterval(this.reconnectEventCallback, 2000);
    }, delay);
  }

  removeReconnectListeners() {
    clearInterval(this.reconnectInterval);
    window.removeEventListener("focus", this.reconnectEventCallback);
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

let reloader = new EleventyReload();
reloader.init();

window.EleventyReload = reloader;