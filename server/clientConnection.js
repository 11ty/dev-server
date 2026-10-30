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

// Gives a new client an id and the normalized page from its `?page=` param.
/**
 * @param {object} client
 * @param {{ url?: string }} req
 */
export function registerConnection(client, req) {
  let page = new URL(req.url || "/", "http://localhost/").searchParams.get("page");
  let connection = {
    clientId: randomUUID(),
    page: page ? normalizePath(page) : undefined,
  };
  connections.set(client, connection);
  return connection;
}

/** @param {object} client */
export function getConnection(client) {
  return connections.get(client);
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

// Sends a reload to each client with only the templates for its page, serializing once per page.
/**
 * @param {Iterable<EventStreamClient>} clients
 * @param {Record<string, any>} obj
 */
export function sendReloadByPage(clients, obj) {
  let jsonByPage = new Map();
  for(let client of clients) {
    let page = getConnection(client)?.page;
    if(!jsonByPage.has(page)) {
      jsonByPage.set(page, JSON.stringify(getReloadForPage(obj, page)));
    }
    client.send(jsonByPage.get(page), obj.buildId);
  }
}

const MAX_MESSAGE_BYTES = 1024 * 1024;
// A tab with this much unsent data has stopped reading; it reconnects once it recovers.
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

// One tab’s open `text/event-stream` response.
export class EventStreamClient {
  /** @param {any} res */
  constructor(res) {
    this.res = res;
  }

  /**
   * @param {string} json
   * @param {string} [id] Browsers send the last one back as `Last-Event-ID` when they reconnect.
   */
  send(json, id) {
    // HTTP/2 responses buffer on their stream
    let writable = this.res.stream || this.res;
    if(writable.destroyed || this.res.writableEnded) {
      return;
    }
    if(writable.writableLength > MAX_BUFFERED_BYTES) {
      writable.destroy();
      return;
    }
    this.res.write(`${id ? `id: ${id}\n` : ""}data: ${json}\n\n`);
  }

  close() {
    if(!this.res.writableEnded) {
      this.res.end();
    }
  }
}

/** @returns {Promise<Buffer | undefined>} `undefined` when larger than `limit`. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if(size <= limit) {
        chunks.push(chunk);
      }
    });
    req.on("end", () => resolve(size <= limit ? Buffer.concat(chunks) : undefined));
    req.on("error", reject);
  });
}

/**
 * Live reload over Server-Sent Events: a `GET` opens a tab’s stream and a `POST` carries a message from a tab.
 */
export class ReloadChannel {
  /** @type {Set<EventStreamClient>} */
  clients = new Set();
  #options;
  #blocked = new Set();

  /**
   * @param {{
   *   allowedHosts?: string[] | true,
   *   getBuildId: () => string,
   *   onClientMessage: (message: Record<string, any>) => void,
   *   onClientCount?: (size: number) => void,
   *   logError: (message: string) => void,
   * }} options
   */
  constructor(options) {
    this.#options = options;
  }

  #isAllowed(req) {
    // HTTP/2 requests have `:authority` instead of `host`
    let host = req.headers.host || req.headers[":authority"];
    let { origin } = req.headers;
    if(isConnectionAllowed({ origin, host }, this.#options.allowedHosts)) {
      return true;
    }
    let key = `${origin} ${host}`;
    if(!this.#blocked.has(key)) {
      this.#blocked.add(key);
      this.#options.logError(`Blocked a live reload connection from origin ${origin} to host ${host}. Add the hostname to the \`allowedHosts\` server option if this was you.`);
    }
    return false;
  }

  #end(res, statusCode, json) {
    res.writeHead(statusCode, json ? { "Content-Type": "application/json" } : {});
    res.end(json);
  }

  #findClient(clientId) {
    for(let client of this.clients) {
      if(getConnection(client)?.clientId === clientId) {
        return client;
      }
    }
  }

  handle(req, res) {
    if(!this.#isAllowed(req)) {
      return this.#end(res, 403);
    }
    if(req.method === "GET") {
      return this.#open(req, res);
    }
    if(req.method === "POST") {
      return this.#receive(req, res);
    }
    res.setHeader("Allow", "GET, POST");
    this.#end(res, 405);
  }

  #open(req, res) {
    let client = new EventStreamClient(res);
    let { clientId } = registerConnection(client, req);
    this.clients.add(client);
    res.on("close", () => {
      this.clients.delete(client);
      this.#options.onClientCount?.(this.clients.size);
    });

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      // Stops nginx from holding events back
      "X-Accel-Buffering": "no",
    });

    // Update the count before the client hears it's connected
    this.#options.onClientCount?.(this.clients.size);

    let buildId = this.#options.getBuildId();
    client.send(JSON.stringify({
      type: "eleventy.status",
      status: "connected",
      buildId,
      clientId,
    }), buildId);
  }

  // JSON only, which cross-site pages can't send without a CORS preflight that is never answered.
  async #receive(req, res) {
    if(!(req.headers["content-type"] || "").startsWith("application/json")) {
      return this.#end(res, 415);
    }

    let clientId = new URL(req.url, "http://localhost/").searchParams.get("clientId");
    if(!this.#findClient(clientId)) {
      return this.#end(res, 404);
    }

    let body = await readBody(req, MAX_MESSAGE_BYTES);
    if(!body) {
      return this.#end(res, 413);
    }

    let parsed = parseClientMessage(body);
    if(!parsed) {
      return this.#end(res, 400);
    }

    this.#end(res, 200, JSON.stringify({ type: "eleventy.ack", id: parsed.id }));
    this.#options.onClientMessage(Object.assign({}, parsed, { clientId }));
  }

  /**
   * @param {string} json
   * @param {{ clientId?: string, id?: string }} [options]
   */
  send(json, { clientId, id } = {}) {
    for(let client of this.clients) {
      if(!clientId || getConnection(client)?.clientId === clientId) {
        client.send(json, id);
      }
    }
  }

  /** @param {Record<string, any>} obj */
  sendByPage(obj) {
    sendReloadByPage(this.clients, obj);
  }

  close() {
    for(let client of this.clients) {
      client.close();
    }
    this.clients.clear();
  }
}
