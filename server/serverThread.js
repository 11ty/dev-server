import fs from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { createSecureServer } from "node:http2";
import { parentPort as maybeParentPort, workerData } from "node:worker_threads";

import mime from "mime";

import StaticFiles from "./staticFiles.js";
import { isPortInUse, portInUseError } from "./portCheck.js";
import { ReloadChannel, PageBaselines } from "./clientConnection.js";
import wrapResponse from "./wrapResponse.js";

// Built into Node 24+, and kept out of the generated types
if(!globalThis.URLPattern) {
  createRequire(import.meta.url)("urlpattern-polyfill");
}

// Always set, since this file only runs as a worker
const parentPort = /** @type {import("node:worker_threads").MessagePort} */ (maybeParentPort);

/**
 * Runs the HTTP server and live reload streams on a dedicated thread so that request
 * handling is never blocked by build work on the main thread.
 *
 * Requests are answered entirely here whenever possible. Requests that need
 * user-supplied code (`middleware`, `onRequest`) are proxied to the main
 * thread, which is no slower than handling them there in the first place.
 */
class ServerThread {
  #server;
  #reloadChannel;
  #staticFiles;
  #options;
  #onRequestPatterns = [];
  #pendingProxies = new Map();
  #proxyId = 0;
  #portRetryCount = 0;
  #closing = false;
  #buildId;
  #baselines = new PageBaselines();

  constructor({ dir, options, onRequestPatterns, hasMiddleware, passthroughCopies, port, host, buildId }) {
    this.#options = options;
    this.#buildId = buildId;
    this.hasMiddleware = hasMiddleware;
    this.startPort = port;
    this.host = host;

    this.#staticFiles = new StaticFiles(dir, Object.assign({}, options, {
      logger: {
        info: (...args) => this.#log("info", args),
        log: (...args) => this.#log("log", args),
        error: (...args) => this.#log("error", args),
      },
    }));

    this.#staticFiles.setPassthroughCopies(passthroughCopies);

    for(let pattern of onRequestPatterns) {
      this.#onRequestPatterns.push({
        source: pattern,
        pattern: new URLPattern({ pathname: this.#staticFiles.getServerPath(pattern) }),
      });
    }
  }

  #log(level, args) {
    parentPort.postMessage({ type: "log", level, args: args.map(a => String(a)) });
  }

  get #protocol() {
    let { key, cert } = this.#options.https || {};
    return key && cert ? "https:" : "http:";
  }

  listen() {
    let { key, cert } = this.#options.https || {};
    if(key && cert) {
      this.#server = createSecureServer({
        allowHTTP1: true,
        key: fs.readFileSync(key),
        cert: fs.readFileSync(cert),
      }, this.#onRequest.bind(this));
    } else {
      this.#server = createServer(this.#onRequest.bind(this));
    }

    this.#server.on("error", (err) => {
      if(err.code === "EADDRINUSE") {
        if(this.#portRetryCount < this.#options.portReassignmentRetryCount) {
          this.#portRetryCount++;
          this.#listen(err.port + 1);
          return;
        }
        parentPort.postMessage({
          type: "fatal",
          message: `Tried ${this.#options.portReassignmentRetryCount} different ports but they were all in use. You can a different starter port using --port on the command line.`,
        });
        return;
      }
      parentPort.postMessage({ type: "serverError", code: err.code, port: err.port, message: err.message });
    });

    this.#server.on("listening", () => {
      this.#setupReloadNotifier();
      parentPort.postMessage({
        type: "listening",
        port: this.#server.address().port,
        protocol: this.#protocol,
      });
    });

    this.#listen(this.startPort);
  }

  async #listen(port) {
    // Goes through the usual retry on the next port
    if(await isPortInUse(port, this.host)) {
      this.#server.emit("error", portInUseError(port));
      return;
    }
    this.#server.listen({ port, host: this.host });
  }

  // Injects the live reload client into HTML responses. Mirrors the main thread.
  #transformHtml(req, res) {
    return (content) => {
      // check to see if this is a client fetch and not a navigation
      let isXHR = req.headers["sec-fetch-mode"] && req.headers["sec-fetch-mode"] != "navigate";

      if(this.#options.liveReload !== false && !isXHR) {
        if(this.#options.domDiff && res.statusCode === 200) {
          this.#baselines.set(new URL(req.url, "http://localhost/").pathname, content);
        }

        let scriptContents = this.#staticFiles.getReloadClientContents();
        let integrityHash = this.#staticFiles.sri(scriptContents);

        return this.#staticFiles.augmentContentWithNotifier(content, {
          scriptContents,
          integrityHash,
        });
      }

      return content;
    };
  }

  #matchesOnRequest(url) {
    if(this.#onRequestPatterns.length === 0) {
      return false;
    }
    // `url` already includes the pathPrefix
    let fullUrl = `${this.#protocol}//localhost${url}`;
    return this.#onRequestPatterns.some(({ pattern }) => pattern.exec(fullUrl));
  }

  // Serves the two files injected by the dev server itself. Always local to this thread.
  #serveInjectedScript(req, res) {
    let { liveReload, domDiff } = this.#options;
    let injectedScript = this.#staticFiles.matchInjectedScript(req.url);

    if(injectedScript === "reload-client.js") {
      if(liveReload) {
        res.setHeader("Content-Type", mime.getType("js"));
        res.end(this.#staticFiles.getReloadClientContents());
        return true;
      }
    } else if(injectedScript === "idiomorph.js") {
      if(domDiff) {
        res.setHeader("Content-Type", mime.getType("js"));
        res.end(this.#staticFiles.readFile(this.#staticFiles.getIdiomorphPath()));
        return true;
      }
    }
    return false;
  }

  async #onRequest(req, res) {
    if(this.#closing) {
      return res.end("");
    }

    res = wrapResponse(res, this.#transformHtml(req, res));

    try {
      await this.#handleRequest(req, res);
    } catch(e) {
      // Never let a request take down the thread: that would take the whole server with it.
      this.#log("error", [`Server error: ${e.message}`]);
      if(!res.writableEnded) {
        this.#staticFiles.sendError(req, res, 500, e.message);
      }
    }
  }

  async #handleRequest(req, res) {
    if(this.#reloadChannel && this.#staticFiles.matchInjectedScript(req.url) === "events") {
      return this.#reloadChannel.handle(req, res);
    }

    if(this.#serveInjectedScript(req, res)) {
      return;
    }

    // Fast path: nothing user-supplied can claim this request, so never touch the main thread.
    if(!this.hasMiddleware && !this.#matchesOnRequest(req.url)) {
      return this.#staticFiles.serve(req, res);
    }

    // Slow path: user code lives on the main thread.
    let result = await this.#proxyToMainThread(req, res);
    if(result.aborted) {
      return;
    }

    if(result.error) {
      if(res.headersSent) {
        return res._wrappedOriginalEnd.call(res);
      }
      return this.#staticFiles.sendError(req, res, 500, result.error);
    }

    if(result.ended) {
      // The body was already streamed and transformed on the main thread, write through untouched.
      this.#writeProxyHead(res, result);
      return res._wrappedOriginalEnd.call(res);
    }

    this.#setProxyHeaders(res, result.headers);

    // Middleware fell through: serve the file from this thread.
    if(typeof result.statusCode === "number" && result.statusCode !== 200) {
      res.statusCode = result.statusCode;
    }
    if(typeof result.body === "string") {
      res.body = result.body;
    }
    if(result.shouldForceEnd) {
      res._shouldForceEnd = true;
    }

    return this.#staticFiles.serve(req, res);
  }

  #readRequestBody(req) {
    if(req.method === "GET" || req.method === "HEAD") {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve, reject) => {
      let chunks = [];
      req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => resolve(chunks.length > 0 ? Buffer.concat(chunks) : undefined));
      req.on("error", reject);
    });
  }

  #setProxyHeaders(res, headers = {}) {
    for(let [key, value] of Object.entries(headers)) {
      if(value !== undefined) {
        res.setHeader(key, value);
      }
    }
  }

  #writeProxyHead(res, { statusCode, headers }) {
    if(res.headersSent) {
      return;
    }
    this.#setProxyHeaders(res, headers);
    if(typeof statusCode === "number") {
      res.statusCode = statusCode;
    }
    res._wrappedOriginalWriteHead.call(res, res.statusCode);
  }

  async #proxyToMainThread(req, res) {
    let body = await this.#readRequestBody(req);
    let id = ++this.#proxyId;
    let { remoteAddress, remotePort, remoteFamily, localAddress, localPort } = req.socket || {};

    return new Promise((resolve) => {
      this.#pendingProxies.set(id, { res, resolve });

      // Tell the main thread when the client gives up first, so streaming middleware can stop.
      res.on("close", () => {
        if(this.#pendingProxies.delete(id)) {
          parentPort.postMessage({ type: "proxyAbort", id });
          resolve({ aborted: true });
        }
      });

      parentPort.postMessage({
        type: "proxyRequest",
        id,
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
        socket: {
          remoteAddress,
          remotePort,
          remoteFamily,
          localAddress,
          localPort,
          encrypted: this.#protocol === "https:",
        },
      });
    });
  }

  #setupReloadNotifier() {
    this.#reloadChannel = new ReloadChannel({
      allowedHosts: this.#options.allowedHosts,
      getBuildId: () => this.#buildId,
      logError: (message) => this.#log("error", [message]),
      onClientCount: (size) => parentPort.postMessage({ type: "clientCount", size }),
      onClientMessage: (parsed) => parentPort.postMessage({ type: "clientMessage", parsed }),
    });
  }

  #closeOne(server) {
    return new Promise((resolve) => {
      server.close(() => resolve(undefined));
      if("closeAllConnections" in server) {
        server.closeAllConnections();
      }
    });
  }

  async close() {
    this.#closing = true;

    // Open streams would keep the server from closing
    this.#reloadChannel?.close();

    let promises = [];

    if(this.#server?.listening) {
      promises.push(this.#closeOne(this.#server));
    }

    await Promise.all(promises);
    parentPort.postMessage({ type: "closed" });
  }

  onMessage(msg) {
    if(msg.type === "proxyResponse") {
      let pending = this.#pendingProxies.get(msg.id);
      if(pending) {
        this.#pendingProxies.delete(msg.id);
        pending.resolve(msg);
      }
    } else if(msg.type === "proxyHead") {
      let pending = this.#pendingProxies.get(msg.id);
      if(pending) {
        this.#writeProxyHead(pending.res, msg);
      }
    } else if(msg.type === "proxyChunk") {
      let pending = this.#pendingProxies.get(msg.id);
      if(pending) {
        pending.res._wrappedOriginalWrite.call(pending.res, Buffer.from(msg.chunk));
      }
    } else if(msg.type === "broadcast") {
      // Reload payloads carry the new `buildId` for future connection messages
      if(msg.buildId) {
        this.#buildId = msg.buildId;
      }
      if(msg.byPage) {
        this.#reloadChannel?.sendByPage(this.#baselines.apply(JSON.parse(msg.json)));
      } else if(msg.hasTemplates) {
        this.#reloadChannel?.send(JSON.stringify(this.#baselines.apply(JSON.parse(msg.json))), { clientId: msg.clientId, id: msg.buildId });
      } else {
        this.#reloadChannel?.send(msg.json, { clientId: msg.clientId, id: msg.buildId });
      }
    } else if(msg.type === "passthroughCopies") {
      this.#staticFiles.setPassthroughCopies(msg.entries);
    } else if(msg.type === "close") {
      this.close();
    }
  }
}

const thread = new ServerThread(workerData);
parentPort.on("message", (msg) => thread.onMessage(msg));
thread.listen();
