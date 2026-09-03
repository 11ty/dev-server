import fs from "node:fs";
import { createServer } from "node:http";
import { createSecureServer } from "node:http2";
import { parentPort, workerData } from "node:worker_threads";

import "urlpattern-polyfill";
import mime from "mime";
import WebSocket, { WebSocketServer } from "ws";

import StaticFiles from "./staticFiles.js";
import wrapResponse from "./wrapResponse.js";

const POLITE_WEBSOCKET_CLOSE_TIMEOUT = 50; // in ms

/**
 * Runs the HTTP + WebSocket servers on a dedicated thread so that request
 * handling is never blocked by build work on the main thread.
 *
 * Requests are answered entirely here whenever possible. Requests that need
 * user-supplied code (`middleware`, `onRequest`) are proxied to the main
 * thread, which is no slower than handling them there in the first place.
 */
class ServerThread {
  #server;
  #updateServer;
  #staticFiles;
  #options;
  #onRequestPatterns = [];
  #pendingProxies = new Map();
  #proxyId = 0;
  #portRetryCount = 0;
  #closing = false;

  constructor({ dir, options, onRequestPatterns, hasMiddleware, passthroughAliases, port }) {
    this.#options = options;
    this.hasMiddleware = hasMiddleware;
    this.startPort = port;

    this.#staticFiles = new StaticFiles(dir, Object.assign({}, options, {
      logger: {
        info: (...args) => this.#log("info", args),
        log: (...args) => this.#log("log", args),
        error: (...args) => this.#log("error", args),
      },
    }));

    this.#staticFiles.setAliases(passthroughAliases);

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
          this.#server.listen({ port: err.port + 1 });
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

    this.#server.listen({ port: this.startPort });
  }

  // Injects the live reload client into HTML responses. Mirrors the main thread.
  #transformHtml(req, res) {
    return (content) => {
      // check to see if this is a client fetch and not a navigation
      let isXHR = req.headers["sec-fetch-mode"] && req.headers["sec-fetch-mode"] != "navigate";

      if(this.#options.liveReload !== false && !isXHR) {
        let scriptContents = this.#staticFiles.getReloadClientContents();
        let integrityHash = this.#staticFiles.sri(scriptContents);

        // Bare (not-custom) finalhandler error pages have a Content-Security-Policy `default-src 'none'` that
        // prevents the client script from executing, so we override it
        if(res.statusCode !== 200 && !res.isCustomErrorPage) {
          res.setHeader("Content-Security-Policy", `script-src '${integrityHash}'`);
        }
        return this.#staticFiles.augmentContentWithNotifier(content, res.statusCode !== 200, {
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
    let { injectedScriptsFolder, liveReload, domDiff } = this.#options;

    if(req.url.startsWith(`/${injectedScriptsFolder}/reload-client.js`)) {
      if(liveReload) {
        res.setHeader("Content-Type", mime.getType("js"));
        res.end(this.#staticFiles.getReloadClientContents());
        return true;
      }
    } else if(req.url === `/${injectedScriptsFolder}/morphdom.js`) {
      if(domDiff) {
        res.setHeader("Content-Type", mime.getType("js"));
        res.end(this.#staticFiles.readFile(this.#staticFiles.getMorphdomPath()));
        return true;
      }
    }
    return false;
  }

  async #onRequest(req, res) {
    try {
      await this.#handleRequest(req, res);
    } catch(e) {
      // Never let a request take down the thread: that would take the whole server with it.
      this.#log("error", [`Server error: ${e.message}`]);
      if(!res.writableEnded) {
        res.statusCode = 500;
        res.end("");
      }
    }
  }

  async #handleRequest(req, res) {
    if(this.#closing) {
      return res.end("");
    }

    res = wrapResponse(res, this.#transformHtml(req, res));

    if(this.#serveInjectedScript(req, res)) {
      return;
    }

    // Fast path: nothing user-supplied can claim this request, so never touch the main thread.
    if(!this.hasMiddleware && !this.#matchesOnRequest(req.url)) {
      return this.#staticFiles.serve(req, res);
    }

    // Slow path: user code lives on the main thread.
    let result = await this.#proxyToMainThread(req, res);

    if(result.error) {
      res.statusCode = 500;
      return res.end(result.error);
    }

    for(let [key, value] of Object.entries(result.headers || {})) {
      if(value !== undefined) {
        res.setHeader(key, value);
      }
    }

    if(result.ended) {
      if(typeof result.statusCode === "number") {
        res.statusCode = result.statusCode;
      }
      // Already transformed on the main thread, write through untouched.
      return res._wrappedOriginalEnd.call(res, result.body ? Buffer.from(result.body) : undefined);
    }

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

  async #proxyToMainThread(req, res) {
    let body = await this.#readRequestBody(req);
    let id = ++this.#proxyId;

    return new Promise((resolve) => {
      this.#pendingProxies.set(id, resolve);

      // Don't leak the pending entry if the client gives up first.
      res.on("close", () => this.#pendingProxies.delete(id));

      parentPort.postMessage({
        type: "proxyRequest",
        id,
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      });
    });
  }

  #setupReloadNotifier() {
    let options = {};
    if(this.#options.reloadPort) {
      options.port = this.#options.reloadPort;
    } else {
      // includes the port
      options.server = this.#server;
    }

    let updateServer = new WebSocketServer(options);
    updateServer.on("connection", (ws) => {
      this.broadcast({
        type: "eleventy.status",
        status: "connected",
      }, ws);

      parentPort.postMessage({ type: "clientCount", size: updateServer.clients.size });

      ws.on("close", () => {
        parentPort.postMessage({ type: "clientCount", size: updateServer.clients.size });
      });

      ws.on("message", (data) => {
        let parsed = JSON.parse(data.toString());
        if(parsed.id) {
          // send acknowledgement
          this.broadcast({
            type: "eleventy.ack",
            id: parsed.id,
          });
        }

        parentPort.postMessage({ type: "clientMessage", parsed });
      });
    });

    updateServer.on("error", (err) => {
      parentPort.postMessage({ type: "serverError", code: err.code, port: err.port, message: err.message });
    });

    this.#updateServer = updateServer;
  }

  broadcast(obj, include) {
    if(!this.#updateServer?.clients) {
      return;
    }
    for(let client of this.#updateServer.clients) {
      if((!include || include === client) && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(obj));
      }
    }
  }

  #closeOne(server) {
    return new Promise((resolve) => {
      server.close(() => resolve());
      if("closeAllConnections" in server) {
        server.closeAllConnections();
      }
    });
  }

  async close() {
    this.#closing = true;

    let promises = [];
    if(this.#updateServer) {
      this.#updateServer.clients.forEach(socket => {
        socket.close();
        if("terminate" in socket) {
          // More aggressive close, `close()` waits for a response from the client and terminate does not.
          setTimeout(() => socket.terminate(), POLITE_WEBSOCKET_CLOSE_TIMEOUT);
        }
      });
      promises.push(this.#closeOne(this.#updateServer));
    }

    if(this.#server?.listening) {
      promises.push(this.#closeOne(this.#server));
    }

    await Promise.all(promises);
    parentPort.postMessage({ type: "closed" });
  }

  onMessage(msg) {
    if(msg.type === "proxyResponse") {
      let resolve = this.#pendingProxies.get(msg.id);
      if(resolve) {
        this.#pendingProxies.delete(msg.id);
        resolve(msg);
      }
    } else if(msg.type === "broadcast") {
      this.broadcast(msg.payload);
    } else if(msg.type === "aliases") {
      this.#staticFiles.setAliases(msg.aliases);
    } else if(msg.type === "close") {
      this.close();
    }
  }
}

const thread = new ServerThread(workerData);
parentPort.on("message", (msg) => thread.onMessage(msg));
thread.listen();
