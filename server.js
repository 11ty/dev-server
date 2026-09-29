import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createSecureServer } from "node:http2";
import { createServer } from "node:http";
import { Worker } from "node:worker_threads";

import "urlpattern-polyfill";
import WebSocket, { WebSocketServer } from "ws";
import mime from "mime";
import chokidar from "chokidar";
import { isPlainObject } from "@11ty/eleventy-utils";
import { createDebug } from "obug";

import wrapResponse from "./server/wrapResponse.js";
import ipAddress from "./server/ipAddress.js";
import StaticFiles from "./server/staticFiles.js";
import { parseClientMessage, isConnectionAllowed } from "./server/clientConnection.js";

const require = createRequire(import.meta.url);
const pkg = require("./package.json");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const debug = createDebug("Eleventy:DevServer");

const DEFAULT_OPTIONS = {
  port: 8080,
  reloadPort: false,    // Falsy uses same as `port`
  liveReload: true,     // Enable live reload at all
  showAllHosts: false,  // IP address based hosts (other than localhost)
  injectedScriptsFolder: ".11ty", // Change the name of the special folder used for injected scripts
  portReassignmentRetryCount: 10, // number of times to increment the port if in use
  https: {},            // `key` and `cert`, required for http/2 and https
  domDiff: true,        // Use morphdom to apply DOM diffing delta updates to HTML
  showVersion: false,   // Whether or not to show the server version on the command line.
  encoding: "utf-8",    // Default file encoding
  pathPrefix: "/",      // May be overridden by Eleventy, adds a virtual base directory to your project
  watch: [],            // Globs to pass to separate dev server chokidar for watching
  chokidarOptions: {},  // Options to configure chokidar
  chokidar: undefined,  // Override to watch instance (bypasses both `watch` and `chokidarOptions`)
  aliases: {},          // Aliasing feature
  indexFileName: "index.html", // Allow custom index file name
  useCache: false,      // Use a cache for file contents
  headers: {},          // Set default response headers
  allowedHosts: [],     // Extra hostnames allowed to connect to live reload (localhost and IP addresses always are), or `true` for any
  serverThread: true,   // Run the HTTP server on a worker thread so requests stay fast during builds
  messageOnStart: ({ hosts, startupTime, version, options }) => {
    let hostsStr = " started";
    if(Array.isArray(hosts) && hosts.length > 0) {
      // TODO what happens when the cert doesn't cover non-localhost hosts?
      hostsStr = ` at ${hosts.join(" or ")}`;
    }

    return `Server${hostsStr}${options.showVersion ? ` (v${version})` : ""}`;
  },
  messageOnClose() {
    return `Server closed.`;
  },
  onRequest: {},        // Maps URLPatterns to dynamic callback functions that run on a request from a client.

  // Example:
  // "/foo/:name": function({ url, pattern, patternGroups }) {
  //   return {
  //     headers: {
  //       "Content-Type": "text/html",
  //     },
  //     body: `${url} ${JSON.stringify(patternGroups)}`
  //   }
  // }

  // Logger (fancier one is injected by Eleventy)
  logger: {
    info: console.log,
    log: console.log,
    error: console.error,
  },

  onClientMessage: function({ id, type, data, timestamp }) {
    // console.log( "Received:", data );
  },
}

// Option keys that are safe to structured-clone across to the server thread.
const THREAD_TRANSFERABLE_OPTIONS = [
  "reloadPort",
  "liveReload",
  "injectedScriptsFolder",
  "portReassignmentRetryCount",
  "https",
  "domDiff",
  "encoding",
  "pathPrefix",
  "aliases",
  "indexFileName",
  "useCache",
  "headers",
  "allowedHosts",
];

const POLITE_WEBSOCKET_CLOSE_TIMEOUT = 50; // in ms
const MAX_WORKER_RESTARTS = 5;

export default class DevServer {
  #watcher;
  #serverClosing;
  #serverState;
  #readyPromise;
  #readyResolve;
  #readyReject;

  #portPromise;
  #portResolve;
  #portReject;
  #staticFiles;
  #worker;
  #workerClosed;
  #port;
  #updateServer;
  #threadClientCount = 0;
  #workerListening = false;
  #workerRestarts = 0;
  #proxyResponses = new Map();

  // `buildId` names the current content: new per process, bumped per reload. Clients compare
  // it on reconnect to see if they missed a build—see client/reload-client.js
  #serverInstanceId = crypto.randomUUID();
  #buildCount = 0;

  static getServer(...args) {
    return new DevServer(...args);
  }

  constructor(name, dir, options = {}) {
    debug("Creating new Dev Server instance.")
    this.name = name;
    this.normalizeOptions(options);

    this.fileCache = {};
    // Directory to serve
    if(!dir) {
      throw new Error("Missing `dir` to serve.");
    }
    this.dir = dir;

    this.#staticFiles = new StaticFiles(dir, this.options);

    this.getWatcher();

    this.#readyPromise = new Promise((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
    });

    this.#portPromise = new Promise((resolve, reject) => {
      this.#portResolve = resolve;
      this.#portReject = reject;
    });

    // Rejections surface through `ready()` and `getPort()`, not as unhandled rejections
    this.#readyPromise.catch(() => {});
    this.#portPromise.catch(() => {});
  }

  get logger() {
    return this.options.logger;
  }

  /**
   * Whether the HTTP server runs on a dedicated worker thread.
   * @returns {boolean}
   */
  get isThreaded() {
    return this.options.serverThread !== false;
  }

  #hasUserRequestHandlers() {
    return (this.options.middleware || []).length > 0;
  }

  get buildId() {
    return `${this.#serverInstanceId}:${this.#buildCount}`;
  }

  normalizeOptions(options = {}) {
    this.options = Object.assign({}, DEFAULT_OPTIONS, options);

    // better names for options https://github.com/11ty/eleventy-dev-server/issues/41
    if(options.folder !== undefined) {
      this.options.injectedScriptsFolder = options.folder;
      delete this.options.folder;
    }
    if(options.domdiff !== undefined) {
      this.options.domDiff = options.domdiff;
      delete this.options.domdiff;
    }
    if(options.enabled !== undefined) {
      this.options.liveReload = options.enabled;
      delete this.options.enabled;
    }

    this.options.pathPrefix = this.cleanupPathPrefix(this.options.pathPrefix);

    this.#staticFiles?.setOptions(this.options);
  }

  get watcher() {
    if(this.#watcher) {
      return this.#watcher;
    }

    debug("Watching files: %O", this.options.watch);
    if(!this.options.chokidar) {
      this.#watcher = chokidar.watch(this.options.watch, Object.assign({
        ignoreInitial: true,

        ignored: ["**/node_modules/**", ".git"],

        // same values as Eleventy core
        awaitWriteFinish: {
          stabilityThreshold: 150,
          pollInterval: 25,
        },
      }, this.options.chokidarOptions));
    } else {
      this.#watcher = this.options.chokidar;
    }

    this.#watcher.on("change", (path) => {
      this.logger.log( `File changed: ${path} (skips build)` );
      this.reloadFiles([path]);
    });

    this.#watcher.on("add", (path) => {
      this.logger.log( `File added: ${path} (skips build)` );
      this.reloadFiles([path]);
    });

    this.#watcher.on("unlink", (path) => {
      this.logger.log( `File deleted: ${path} (skips build)` );
      this.reloadFiles([path]);
    });

    return this.#watcher;
  }

  getWatcher() {
    // only initialize watcher if watcher via getWatcher if has targets
    // this.watcher in watchFiles() is a manual workaround
    if(this.options.watch.length > 0 || this.options.chokidar) {
      return this.watcher;
    }
  }

  watchFiles(targets) {
    if(Array.isArray(targets) && targets.length > 0) {
      debug("Also watching: %O", targets);
      this.watcher.add(targets);
    }
  }

  cleanupPathPrefix(pathPrefix) {
    if(!pathPrefix || pathPrefix === "/") {
      return "/";
    }
    if(!pathPrefix.startsWith("/")) {
      pathPrefix = `/${pathPrefix}`
    }
    if(!pathPrefix.endsWith("/")) {
      pathPrefix = `${pathPrefix}/`;
    }
    return pathPrefix;
  }

  /* Static file resolution and serving lives in `server/staticFiles.js` so that it can
   * run either here or on the server thread. These stay as delegates for API compatibility. */

  setAliases(aliases) {
    this.#staticFiles.setAliases(aliases);
    this.#worker?.postMessage({ type: "aliases", aliases });
  }

  matchPassthroughAlias(url) {
    return this.#staticFiles.matchPassthroughAlias(url);
  }

  isFileInDirectory(dir, file) {
    return this.#staticFiles.isFileInDirectory(dir, file);
  }

  getOutputDirFilePath(filepath, filename = "") {
    return this.#staticFiles.getOutputDirFilePath(filepath, filename);
  }

  isOutputFilePathExists(rawPath) {
    return this.#staticFiles.isOutputFilePathExists(rawPath);
  }

  mapUrlToFilePath(url) {
    return this.#staticFiles.mapUrlToFilePath(url);
  }

  augmentContentWithNotifier(content, inlineContents = false, options = {}) {
    return this.#staticFiles.augmentContentWithNotifier(content, inlineContents, options);
  }

  getFileContentType(filepath, res) {
    return this.#staticFiles.getFileContentType(filepath, res);
  }

  renderFile(filepath, res) {
    return this.#staticFiles.renderFile(filepath, res);
  }

  getServerPath(pathname) {
    return this.#staticFiles.getServerPath(pathname);
  }

  // This runs at the end of the middleware chain
  projectStaticMiddleware(req, res) {
    return this.#staticFiles.serve(req, res);
  }

  async devServerMiddleware(req, res, next) {
    if(this.#serverState === "CLOSING") {
      return res.end("");
    }

    for(let urlPatternString in this.options.onRequest) {
      let fn = this.options.onRequest[urlPatternString];
      let fullPath = this.getServerPath(urlPatternString);
      let p = new URLPattern({ pathname: fullPath });

      // request url should already include pathprefix.
      let fullUrl = this.getServerUrlRaw("localhost", req.url);
      let match = p.exec(fullUrl);

      let u = new URL(fullUrl);

      if(match) {
        let result = await fn({
          url: u,
          pattern: p,
          patternGroups: match?.pathname?.groups || {},
        });

        if(!result && result !== "") {
          continue;
        }

        if(typeof result === "string") {
          return res.end(result);
        }

        if(isPlainObject(result) || result instanceof Response) {
          if(typeof result.status === "number") {
            res.statusCode = result.status;
          }

          if(result.headers instanceof Headers) {
            for(let [key, value] of result.headers.entries()) {
              res.setHeader(key, value);
            }
          } else if(isPlainObject(result.headers)) {
            for(let key of Object.keys(result.headers)) {
              res.setHeader(key, result.headers[key]);
            }
          }

          if(result instanceof Response) {
            // no gzip/br compression here, uncompressed from fetch https://github.com/w3c/ServiceWorker/issues/339
            res.removeHeader("content-encoding");

            let arrayBuffer = await result.arrayBuffer();
            res.setHeader("content-length", arrayBuffer.byteLength);

            let buffer = Buffer.from(arrayBuffer);
            return res.end(buffer);
          }

          return res.end(result.body || "");
        }

        throw new Error(`Invalid return type from \`onRequest\` pattern for ${urlPatternString}: expected string, object literal, or Response instance.`);
      }
    } // end onRequest

    if(req.url.startsWith(`/${this.options.injectedScriptsFolder}/reload-client.js`)) {
      if(this.options.liveReload) {
        res.setHeader("Content-Type", mime.getType("js"));
        return res.end(this.#staticFiles.getReloadClientContents());
      }
    } else if(req.url === `/${this.options.injectedScriptsFolder}/morphdom.js`) {
      if(this.options.domDiff) {
        res.setHeader("Content-Type", mime.getType("js"));
        return res.end(this.#staticFiles.readFile(this.#staticFiles.getMorphdomPath()));
      }
    }

    next();
  }

  // Injects the live reload client into HTML responses.
  #transformHtml(req, res) {
    return (content) => {
      // check to see if this is a client fetch and not a navigation
      let isXHR = req.headers["sec-fetch-mode"] && req.headers["sec-fetch-mode"] != "navigate";

      if(this.options.liveReload !== false && !isXHR) {
        let scriptContents = this.#staticFiles.getReloadClientContents();
        let integrityHash = this.#staticFiles.sri(scriptContents);

        // Bare (not-custom) finalhandler error pages have a Content-Security-Policy `default-src 'none'` that
        // prevents the client script from executing, so we override it
        if(res.statusCode !== 200 && !res.isCustomErrorPage) {
          res.setHeader("Content-Security-Policy", `script-src '${integrityHash}'`);
        }
        return this.augmentContentWithNotifier(content, res.statusCode !== 200, {
          scriptContents,
          integrityHash
        });
      }

      return content;
    };
  }

  /**
   * Builds and runs the middleware chain, ending with `terminal`.
   * @param {Function} terminal runs last, after all user middleware
   */
  async #runMiddlewareChain(req, res, terminal) {
    let middlewares = this.options.middleware || [];
    middlewares = middlewares.slice();

    // TODO because this runs at the very end of the middleware chain,
    // if we move the static stuff up in the order we could use middleware to modify
    // the static content in middleware!
    middlewares.push(terminal);
    middlewares.reverse();

    // Runs very first in the middleware chain
    middlewares.push(this.devServerMiddleware);

    let handleError = (e) => {
      this.logger.error(`Server error: ${e.message}`);
      if(!res.bodyUsed) {
        if(!res.headersSent) {
          res.statusCode = 500;
        }
        res.end("");
      }
    };

    let bound = [];
    let next;

    for(let ware of middlewares) {
      let args = next ? [req, res, next] : [req, res];
      // Middleware call `next()` without awaiting it, so each one catches its own errors
      let fn = () => {
        try {
          let result = ware.call(this, ...args);
          return typeof result?.catch === "function" ? result.catch(handleError) : result;
        } catch(e) {
          handleError(e);
        }
      };
      bound.push(fn);
      next = fn;
    }

    bound.reverse();

    let [first] = bound;
    await first();
  }

  async onRequestHandler (req, res) {
    res = wrapResponse(res, this.#transformHtml(req, res));

    await this.#runMiddlewareChain(req, res, this.projectStaticMiddleware);
  }

  /* ---------------------------------------------------------------------- *
   * Server thread
   * ---------------------------------------------------------------------- */

  #startWorker(port) {
    let options = {};
    for(let key of THREAD_TRANSFERABLE_OPTIONS) {
      options[key] = this.options[key];
    }

    this.#worker = new Worker(new URL("./server/serverThread.js", import.meta.url), {
      workerData: {
        dir: this.dir,
        options,
        onRequestPatterns: Object.keys(this.options.onRequest || {}),
        hasMiddleware: this.#hasUserRequestHandlers(),
        // Eleventy may call setAliases() before serve()
        passthroughAliases: this.#staticFiles.passthroughAliases,
        port,
        buildId: this.buildId,
      },
    });

    let worker = this.#worker;
    this.#workerListening = false;

    worker.on("message", (msg) => this.#onWorkerMessage(msg));

    worker.on("error", (err) => {
      this.logger.error(`Server error: ${err.message}`);
    });

    worker.on("exit", (code) => this.#onWorkerExit(worker, code));

    this.start = Date.now();
  }

  // Rejects `ready()` and `getPort()` so callers don't wait on a server that will never listen.
  #failToStart(error) {
    this.logger.error(error.message);
    this.#portReject(error);
    this.#readyReject(error);
  }

  #abortProxyResponses() {
    for(let res of this.#proxyResponses.values()) {
      res.proxyAbort();
    }
    this.#proxyResponses.clear();
  }

  #onWorkerExit(worker, code) {
    // Exits from `close()` or a fatal startup error are expected
    if(worker !== this.#worker) {
      return;
    }

    this.#worker = undefined;
    this.#abortProxyResponses();

    if(this.#workerListening && this.#workerRestarts < MAX_WORKER_RESTARTS) {
      this.#workerRestarts++;
      this.logger.error(`Server thread exited unexpectedly (code ${code}), restarting.`);
      this.#startWorker(this.#port);
      return;
    }

    this.#failToStart(new Error(`Server thread exited unexpectedly (code ${code}).`));
  }

  #onWorkerMessage(msg) {
    if(msg.type === "listening") {
      let isRestart = this.#port !== undefined;
      this.#workerListening = true;
      this.#port = msg.port;
      this._serverProtocol = msg.protocol;
      if(!isRestart) {
        this.#portResolve(msg.port);
        this.logStartMessage();
        this.#readyResolve();
      }
    } else if(msg.type === "proxyRequest") {
      this.#handleProxyRequest(msg);
    } else if(msg.type === "proxyAbort") {
      this.#proxyResponses.get(msg.id)?.proxyAbort();
    } else if(msg.type === "clientMessage") {
      if(typeof this.options.onClientMessage === "function") {
        this.options.onClientMessage(msg.parsed);
      }
    } else if(msg.type === "clientCount") {
      this.#threadClientCount = msg.size;
    } else if(msg.type === "log") {
      this.logger[msg.level]?.(...msg.args);
    } else if(msg.type === "serverError") {
      this._serverErrorHandler({ code: msg.code, port: msg.port, message: msg.message });
    } else if(msg.type === "fatal") {
      let worker = this.#worker;
      this.#worker = undefined;
      worker?.terminate();
      this.#failToStart(new Error(msg.message));
    } else if(msg.type === "closed") {
      this.#workerClosed?.();
    }
  }

  /**
   * A response object that streams everything written to it back to the server thread,
   * so a request proxied from there can run the normal middleware chain here.
   */
  #createProxyResponse(req, id) {
    let res = new http.ServerResponse(req);
    let headSent = false;
    let aborted = false;

    let post = (msg) => {
      if(!aborted) {
        this.#worker?.postMessage(msg);
      }
    };

    let sendHead = () => {
      if(headSent) {
        return;
      }
      headSent = true;
      post({ type: "proxyHead", id, statusCode: res.statusCode, headers: res.getHeaders() });
    };

    res.write = function(data, encoding, callback) {
      if(typeof encoding === "function") {
        callback = encoding;
        encoding = undefined;
      }
      sendHead();
      if(data !== undefined && data !== null) {
        let chunk = Buffer.isBuffer(data) ? data : Buffer.from(data, typeof encoding === "string" ? encoding : "utf8");
        // Copy so a pooled Buffer doesn't clone its whole backing store
        post({ type: "proxyChunk", id, chunk: new Uint8Array(chunk) });
      }
      if(typeof callback === "function") {
        callback();
      }
      return true;
    };

    res.writeHead = function(statusCode, ...args) {
      this.statusCode = statusCode;
      let headers = args[args.length - 1];
      if(headers && typeof headers === "object") {
        for(let key of Object.keys(headers)) {
          this.setHeader(key, headers[key]);
        }
      }
      return this;
    };

    res.flushHeaders = sendHead;

    res.end = function(data, encoding, callback) {
      if(typeof data === "function") {
        callback = data;
        data = undefined;
      } else if(typeof encoding === "function") {
        callback = encoding;
        encoding = undefined;
      }
      if(data !== undefined && data !== null) {
        this.write(data, encoding);
      }
      if(typeof callback === "function") {
        callback();
      }
      this.emit("finish");
      return this;
    };

    // The browser went away: let middleware clean up (e.g. stop a stream)
    res.proxyAbort = () => {
      if(aborted) {
        return;
      }
      aborted = true;
      req.destroy();
      res.emit("close");
    };

    res.isProxyAborted = () => aborted;

    return res;
  }

  async #handleProxyRequest(msg) {
    let reply = { type: "proxyResponse", id: msg.id };

    try {
      // Stands in for the real socket on the server thread
      let socket = Object.assign(new Duplex({ read() {}, write(chunk, encoding, callback) { callback(); } }), msg.socket, {
        setTimeout() {
          return this;
        },
        setNoDelay() {},
        setKeepAlive() {},
      });

      let req = new http.IncomingMessage(socket);
      req.method = msg.method;
      req.url = msg.url;
      req.headers = msg.headers || {};
      req.httpVersion = "1.1";
      req.httpVersionMajor = 1;
      req.httpVersionMinor = 1;

      if(msg.body) {
        req.push(Buffer.from(msg.body));
      }
      req.push(null);

      let res = this.#createProxyResponse(req, msg.id);
      res = wrapResponse(res, this.#transformHtml(req, res));
      this.#proxyResponses.set(msg.id, res);

      // Middleware in the chain call `next()` without awaiting it, so the promise
      // returned by the chain can settle before an async middleware has written
      // anything. Wait on the response itself instead.
      let fellThrough = false;
      let settled = new Promise((resolve, reject) => {
        res.once("finish", resolve);
        res.once("close", resolve);

        // Terminal handler: nothing here claimed the request, so the server thread
        // serves the file itself (keeping file I/O off this thread).
        this.#runMiddlewareChain(req, res, function fallthrough() {
          fellThrough = true;
          resolve();
        }).catch(reject);
      });

      await settled;

      if(res.isProxyAborted()) {
        return;
      }

      if(!fellThrough && res.bodyUsed) {
        // The body was already streamed to the server thread
        reply.ended = true;
        reply.statusCode = res.statusCode;
        reply.headers = res.getHeaders();
      } else {
        reply.fallthrough = true;
        reply.statusCode = res.statusCode;
        reply.headers = res.getHeaders();
        // A middleware may have set a body without ending; hand it along.
        reply.body = res.body;
        reply.shouldForceEnd = res._shouldForceEnd;
      }
    } catch(e) {
      this.logger.error(`Server error: ${e.message}`);
      reply.error = e.message;
    } finally {
      this.#proxyResponses.delete(msg.id);
    }

    this.#worker?.postMessage(reply);
  }

  /* ---------------------------------------------------------------------- *
   * Single-threaded server (used when `serverThread: false`)
   * ---------------------------------------------------------------------- */

  getHosts() {
    let hosts = new Set();
    if(this.options.showAllHosts) {
      for(let host of ipAddress()) {
        hosts.add(this.getServerUrl(host));
      }
    }
    hosts.add(this.getServerUrl("localhost"));
    return Array.from(hosts);
  }

  get server() {
    if (this._server) {
      return this._server;
    }

    this.start = Date.now();

    // Check for secure server requirements, otherwise use HTTP
    let { key, cert } = this.options.https;
    if(key && cert) {
      let options = {
        allowHTTP1: true,

        // Credentials
        key: fs.readFileSync(key),
        cert: fs.readFileSync(cert),
      };
      this._server = createSecureServer(options, this.onRequestHandler.bind(this));
      this._serverProtocol = "https:";
    } else {
      this._server = createServer(this.onRequestHandler.bind(this));
      this._serverProtocol = "http:";
    }

    this.portRetryCount = 0;
    this._server.on("error", (err) => {
      if (err.code == "EADDRINUSE") {
        if (this.portRetryCount < this.options.portReassignmentRetryCount) {
          this.portRetryCount++;
          debug(
            "Server already using port %o, trying the next port %o. Retry number %o of %o",
            err.port,
            err.port + 1,
            this.portRetryCount,
            this.options.portReassignmentRetryCount
          );
          this._serverListen(err.port + 1);
        } else {
          throw new Error(
            `Tried ${this.options.portReassignmentRetryCount} different ports but they were all in use. You can a different starter port using --port on the command line.`
          );
        }
      } else {
        this._serverErrorHandler(err);
      }
    });

    this._server.on("listening", (e) => {
      this.#port = this._server.address().port;
      this.setupReloadNotifier();
      this.logStartMessage();
      this.#portResolve(this.#port);
      this.#readyResolve();
    });

    return this._server;
  }

  async ready() {
    return this.#readyPromise;
  }

  _serverListen(port) {
    this.server.listen({
      port,
    });
  }

  getServerUrlRaw(host, pathname = "", isRaw = true) {
    if(!this.#port || !this._serverProtocol) {
      throw new Error("Access to server url not yet available.");
    }

    return `${this._serverProtocol}//${host}:${this.#port}${isRaw ? pathname : this.getServerPath(pathname)}`;
  }

  getServerUrl(host, pathname = "") {
    return this.getServerUrlRaw(host, pathname, false);
  }

  async getPort() {
    return this.#portPromise;
  }

  serve(port) {
    this.getWatcher();

    if(this.isThreaded) {
      this.#startWorker(port);
    } else {
      this._serverListen(port);
    }
  }

  _serverErrorHandler(err) {
    if (err.code == "EADDRINUSE") {
      this.logger.error(`Server error: Port in use ${err.port}`);
    } else {
      this.logger.error(`Server error: ${err.message}`);
    }
  }

  // Websocket Notifications
  setupReloadNotifier() {
    let options = {};
    if(this.options.reloadPort) {
      options.port = this.options.reloadPort;
    } else {
      // includes the port
      options.server = this.server;
    }

    let blocked = new Set();
    options.verifyClient = ({ origin, req }) => {
      let host = req.headers.host;
      if(isConnectionAllowed({ origin, host }, this.options.allowedHosts)) {
        return true;
      }
      let key = `${origin} ${host}`;
      if(!blocked.has(key)) {
        blocked.add(key);
        this.logger.error(`Blocked a live reload connection from origin ${origin} to host ${host}. Add the hostname to the \`allowedHosts\` server option if this was you.`);
      }
      return false;
    };

    let updateServer = new WebSocketServer(options);
    updateServer.on("connection", (ws) => {
      this.sendUpdateNotification({
        type: "eleventy.status",
        status: "connected",
        buildId: this.buildId,
      }, { include: ws });

      ws.on("message", (data) => {
        let parsed = parseClientMessage(data);
        if(!parsed) {
          return;
        }
        if(parsed.id) {
          // send acknowledgement
          this.sendUpdateNotification({
            type: "eleventy.ack",
            id: parsed.id,
          })
        }

        if(typeof this.options.onClientMessage === "function") {
          this.options.onClientMessage(parsed);
        }
      });
    });

    updateServer.on("error", (err) => {
      this._serverErrorHandler(err);
    });

    this.#updateServer = updateServer;
  }

  get updateServer() {
    if(this.isThreaded) {
      // The websocket server lives on the server thread; expose the client count only.
      return { clients: { size: this.#threadClientCount } };
    }
    return this.#updateServer;
  }

  // Broadcasts to all open browser windows
  sendUpdateNotification(obj, options = {}) {
    if(this.isThreaded) {
      // Serialized here: structured clone throws on values JSON drops (e.g. functions in template `data`)
      this.#worker?.postMessage({ type: "broadcast", json: JSON.stringify(obj), buildId: obj.buildId });
      return;
    }

    if(!this.#updateServer?.clients) {
      return;
    }

    let { include } = options;
    for(let client of this.#updateServer.clients) {
      if ((!include || include === client) && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(obj));
      }
    }
  }

  // Helper for promisifying close methods with callbacks, like http.Server or ws.WebSocketServer.
  async _closeServer(server) {
    return new Promise((resolve, reject) => {
      server.close(err => {
        if (err) {
          reject(err);
        }
        resolve();
      });

      // Note: this method won't exist for updateServer
      if("closeAllConnections" in server) {
        // Node 18.2+
        server.closeAllConnections();
      }
    });
  }

  async #closeWorker() {
    let worker = this.#worker;
    if(!worker) {
      return;
    }
    this.#worker = undefined;

    await new Promise((resolve) => {
      let settled = false;
      let done = () => {
        if(settled) return;
        settled = true;
        resolve();
      };
      this.#workerClosed = done;
      // Don't hang shutdown on a wedged socket.
      let timer = setTimeout(done, 500);
      timer.unref?.();
      worker.postMessage({ type: "close" });
    });

    await worker.terminate();
  }

  async close() {
    // Prevent multiple invocations.
    if (this.#serverClosing) {
      return this.#serverClosing;
    }

    // TODO would be awesome to set a delayed redirect when port changed to redirect to new _server_
    this.sendUpdateNotification({
      type: "eleventy.status",
      status: "disconnected",
    });

    let promises = []

    if(this.#worker) {
      promises.push(this.#closeWorker());
    }

    if(this.#updateServer) {
      // Close all existing WS connections.
      this.#updateServer?.clients.forEach(socket => {
        socket.close();

        if("terminate" in socket) {
          // More aggressive close, `close()` waits for a response from the client and terminate does not.
          setTimeout(() => socket.terminate(), POLITE_WEBSOCKET_CLOSE_TIMEOUT);
        }
      });

      promises.push(this._closeServer(this.#updateServer));
    }

    if(this._server?.listening) {
      promises.push(this._closeServer(this.server));
    }

    if(this.#watcher) {
      promises.push(this.#watcher.close());
      this.#watcher = undefined;
    }

    this.#serverClosing = Promise.all(promises).then(() => {
      this.#serverState = "CLOSED";
      this.#serverClosing = undefined;
      this.logCloseMessage();
    });

    this.#serverState = "CLOSING";

    return this.#serverClosing;
  }

  #logCallback(callback, options) {
    let fn = typeof callback === "function" ? callback : () => false;
    let message = fn(Object.assign({
      options: this.options,
      version: pkg.version,
    }, options));

    if(message && typeof this.logger?.info === "function") {
      this.logger.info(message);
    }
  }

  logStartMessage() {
    let hosts = this.getHosts();
    this.#logCallback(this.options.messageOnStart, {
      hosts,
      localhostUrl: this.getServerUrl("localhost"),
      startupTime: Date.now() - this.start,
    });
  }

  logCloseMessage() {
    this.#logCallback(this.options.messageOnClose);
  }

  sendError({ error }) {
    this.sendUpdateNotification({
      type: "eleventy.error",
      // Thanks https://stackoverflow.com/questions/18391212/is-it-not-possible-to-stringify-an-error-using-json-stringify
      error: JSON.stringify(error, Object.getOwnPropertyNames(error)),
    });
  }

  // reverse of mapUrlToFilePath
  // /resource/ <= /resource/index.html
  // /resource <= resource.html
  getUrlsFromFilePath(path) {
    if(this.dir === ".") {
      path = `/${path}`
    } else {
      path = path.slice(this.dir.length);
    }

    let urls = [];
    urls.push(path);

    if(path.endsWith(`/${this.options.indexFileName}`)) {
      urls.push(path.slice(0, -1 * this.options.indexFileName.length));
    } else if(path.endsWith(".html")) {
      urls.push(path.slice(0, -1 * ".html".length));
    }

    return urls;
  }

  // returns [{ url, inputPath, content }]
  getBuildTemplatesFromFilePath(path) {
    // We can skip this for non-html files, dom-diffing will not apply
    if(!path.endsWith(".html")) {
      return [];
    }

    let urls = this.getUrlsFromFilePath(path);
    let obj = {
      inputPath: path,
      content: fs.readFileSync(path, "utf8"),
    }

    return urls.map(url => {
      return Object.assign({ url }, obj);
    });
  }

  reloadFiles(files, useDomDiffingForHtml = true) {
    if(!Array.isArray(files)) {
      throw new Error("reloadFiles method requires an array of file paths.");
    }

    let subtype;
    if(!files.some((entry) => !entry.endsWith(".css"))) {
      // only if all changes are css changes
      subtype = "css";
    }

    let templates = [];
    if(useDomDiffingForHtml && this.options.domDiff) {
      for(let filePath of files) {
        if(!filePath.endsWith(".html")) {
          continue;
        }
        for(let templateEntry of this.getBuildTemplatesFromFilePath(filePath)) {
          templates.push(templateEntry);
        }
      }
    }

    this.reload({
      files,
      subtype,
      build: {
        templates
      }
    });
  }

  reload(event = {}) {
    let { subtype, files, build } = event;
    if (build?.templates && build.outputs && !this.options.domDiff) {
      // Send changed page URLs without content so the client can still skip reloading untouched pages
      build.templates = build.templates.map(({ url, inputPath, outputPath }) => ({ url, inputPath, outputPath }));
    } else if (build?.templates) {
      build.templates = build.templates
        .filter(entry => {
          if(!this.options.domDiff) {
            // Don't include any files if the dom diffing option is disabled
            return false;
          }

          // Newer Eleventy (`build.outputs`) already filters to templates with changed output
          if(build.outputs) {
            return true;
          }

          // Filter to only include watched templates that were updated
          return (files || []).includes(entry.inputPath);
        });
    }

    this.#buildCount++;

    this.sendUpdateNotification({
      type: "eleventy.reload",
      subtype,
      files,
      build,
      buildId: this.buildId,
    });
  }
}
