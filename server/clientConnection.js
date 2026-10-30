import { isIP } from "node:net";
import { randomUUID } from "node:crypto";

// Returns the parsed message, or `undefined` for anything that isn't a JSON object.
export function parseClientMessage(data) {
  let parsed;
  try {
    parsed = JSON.parse(data.toString());
  } catch(e) {
    return;
  }

  if(parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed;
  }
}

function getHostname(value) {
  try {
    let { hostname } = new URL(value.includes("://") ? value : `http://${value}`);
    // IPv6 hostnames are bracketed, e.g. `[::1]`
    if(hostname.startsWith("[") && hostname.endsWith("]")) {
      return hostname.slice(1, -1);
    }
    return hostname;
  } catch(e) {
    return;
  }
}

// Only domain names can be rebound to this machine, so localhost and IP addresses are always safe.
/**
 * @param {string | undefined} hostname
 * @param {string[] | true} [allowedHosts]
 */
export function isHostnameAllowed(hostname, allowedHosts = []) {
  if(!hostname) {
    return false;
  }
  if(allowedHosts === true || hostname === "localhost" || hostname.endsWith(".localhost") || isIP(hostname)) {
    return true;
  }
  return (allowedHosts || []).some(entry => {
    // A leading `.` also allows subdomains
    return entry.startsWith(".") ? hostname === entry.slice(1) || hostname.endsWith(entry) : hostname === entry;
  });
}

// Blocks connections from other sites (Origin) and DNS rebinding (Host).
export function isConnectionAllowed({ origin, host }, allowedHosts) {
  let hostname = getHostname(host || "");
  if(!isHostnameAllowed(hostname, allowedHosts)) {
    return false;
  }

  // Browsers always send Origin, so its absence means a non-browser client
  if(!origin) {
    return true;
  }

  return getHostname(origin) === hostname;
}

// Matches the client’s `normalizePath`, so `/about`, `/about/`, and `/about/index.html` are the same page.
export function normalizePath(path = "") {
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

/** @type {WeakMap<object, { clientId: string, page: string | undefined }>} */
const connections = new WeakMap();

// Gives a new socket an id and the normalized page from its `?page=` param.
/**
 * @param {object} ws
 * @param {{ url?: string }} req
 */
export function registerConnection(ws, req) {
  let page = new URL(req.url || "/", "http://localhost/").searchParams.get("page");
  let connection = {
    clientId: randomUUID(),
    page: page ? normalizePath(page) : undefined,
  };
  connections.set(ws, connection);
  return connection;
}

/** @param {object} ws */
export function getConnection(ws) {
  return connections.get(ws);
}

// Keeps only `build.templates` for this page; pages without one get `templates: []`.
/**
 * @param {Record<string, any>} obj
 * @param {string | undefined} page
 */
export function getReloadForPage(obj, page) {
  let templates = obj.build?.templates;
  if(!Array.isArray(templates)) {
    return obj;
  }
  return Object.assign({}, obj, {
    build: Object.assign({}, obj.build, {
      templates: templates.filter(({ url }) => page !== undefined && typeof url === "string" && normalizePath(url) === page),
    }),
  });
}

// The HTML each page was last served or sent, so the client can tell source changes from changes made by page scripts.
export class PageBaselines {
  #pages = new Map();

  /**
   * @param {string} url
   * @param {string} content
   */
  set(url, content) {
    this.#pages.set(normalizePath(url), content);
  }

  // Adds `previousContent` to templates with content, then makes their content the new baseline.
  /** @param {Record<string, any>} obj */
  apply(obj) {
    let templates = obj.build?.templates;
    if(!Array.isArray(templates)) {
      return obj;
    }
    return Object.assign({}, obj, {
      build: Object.assign({}, obj.build, {
        templates: templates.map(template => {
          if(typeof template.url !== "string" || typeof template.content !== "string") {
            return template;
          }
          let key = normalizePath(template.url);
          let previousContent = this.#pages.get(key);
          this.#pages.set(key, template.content);
          return previousContent === undefined ? template : Object.assign({}, template, { previousContent });
        }),
      }),
    });
  }
}

// Sends a reload to each open socket with only the templates for its page, serializing once per page.
/**
 * @param {Iterable<any>} clients
 * @param {Record<string, any>} obj
 * @param {number} openState
 */
export function sendReloadByPage(clients, obj, openState) {
  let jsonByPage = new Map();
  for(let client of clients) {
    if(client.readyState !== openState) {
      continue;
    }
    let page = getConnection(client)?.page;
    if(!jsonByPage.has(page)) {
      jsonByPage.set(page, JSON.stringify(getReloadForPage(obj, page)));
    }
    client.send(jsonByPage.get(page));
  }
}
