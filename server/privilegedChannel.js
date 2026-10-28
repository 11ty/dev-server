import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import { isHostnameAllowed, parseClientMessage } from "./clientConnection.js";

export const MIN_TOKEN_LENGTH = 32;
export const CLOSE_AUTH_FAILED = 4401;

const CLOSE_GOING_AWAY = 1001;
const AUTH_TIMEOUT = 5000; // ms
const PING_INTERVAL = 30000; // ms
const POLITE_CLOSE_TIMEOUT = 50; // ms
const MAX_PAYLOAD = 10 * 1024 * 1024;
const REPLY_CACHE_SIZE = 100;
const MAX_SESSIONS = 50;

function digest(value) {
  return createHash("sha256").update(value).digest();
}

// Hashing first gives equal lengths, which `timingSafeEqual` requires.
export function isTokenMatch(expected, actual) {
  return typeof actual === "string" && timingSafeEqual(digest(expected), digest(actual));
}

export function isLoopbackAddress(address = "") {
  let ip = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return ip === "::1" || (isIP(ip) === 4 && ip.startsWith("127."));
}

// Only browsers on this machine, on exactly this server’s origin (port included).
export function isPrivilegedConnectionAllowed({ origin, host, remoteAddress }, allowedHosts) {
  if(!origin || !host || !isLoopbackAddress(remoteAddress)) {
    return false;
  }
  try {
    let url = new URL(origin);
    return url.host === host && isHostnameAllowed(url.hostname.replace(/^\[|\]$/g, ""), allowedHosts);
  } catch(e) {
    return false;
  }
}

/**
 * Authenticated WebSocket connections for privileged clients (see `client/ws-client.js`).
 * Messages go to `onMessage`, whose result is the reply; repeats of a message id in a session get the same reply.
 */
export class PrivilegedChannel {
  #options;
  #wss;
  #ready;
  #sessions = new Map();
  #states = new WeakMap();
  #pingTimer;
  #blocked = new Set();

  /**
   * @param {{
   *   token: string,
   *   allowedHosts?: string[] | true,
   *   onMessage: (message: Record<string, any>) => unknown,
   *   logError: (message: string) => void,
   * }} options
   */
  constructor(options) {
    this.#options = options;
    // Loaded here so `ws` is only imported when privileged clients are on
    this.#ready = import("ws").then(({ WebSocketServer }) => {
      this.#wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
      this.#wss.on("connection", (ws) => this.#onConnection(ws));
      this.#pingTimer = setInterval(() => this.#ping(), PING_INTERVAL);
      this.#pingTimer.unref?.();
    });
  }

  get size() {
    let size = 0;
    for(let session of this.#sessions.values()) {
      size += session.sockets.size;
    }
    return size;
  }

  async handleUpgrade(req, socket, head) {
    let origin = req.headers.origin;
    let host = req.headers.host;
    if(!isPrivilegedConnectionAllowed({ origin, host, remoteAddress: req.socket?.remoteAddress }, this.#options.allowedHosts)) {
      let key = `${origin} ${host}`;
      if(!this.#blocked.has(key)) {
        this.#blocked.add(key);
        this.#options.logError(`Blocked a privileged connection from origin ${origin} to host ${host}.`);
      }
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }

    await this.#ready;
    this.#wss.handleUpgrade(req, socket, head, (ws) => this.#wss.emit("connection", ws));
  }

  #onConnection(ws) {
    /** @type {{ session: any, alive: boolean }} */
    let state = { session: undefined, alive: true };
    this.#states.set(ws, state);

    let authTimer = setTimeout(() => ws.close(CLOSE_AUTH_FAILED, "Authentication timed out"), AUTH_TIMEOUT);

    ws.on("pong", () => state.alive = true);
    ws.on("close", () => {
      clearTimeout(authTimer);
      state.session?.sockets.delete(ws);
    });

    ws.on("message", (data) => {
      let message = parseClientMessage(data);

      // The first message must authenticate
      if(!state.session) {
        clearTimeout(authTimer);
        if(message?.type !== "auth" || typeof message.sessionId !== "string" || !isTokenMatch(this.#options.token, message.token)) {
          ws.close(CLOSE_AUTH_FAILED, "Authentication failed");
          return;
        }
        state.session = this.#getSession(message.sessionId);
        state.session.sockets.add(ws);
        ws.send(JSON.stringify({ type: "buildawesome.auth", ok: true }));
        return;
      }

      if(typeof message?.id === "string" && typeof message.type === "string") {
        this.#receive(state.session, ws, message);
      }
    });
  }

  #getSession(id) {
    let session = this.#sessions.get(id);
    if(session) {
      return session;
    }

    session = { id, sockets: new Set(), replies: new Map() };
    this.#sessions.set(id, session);

    // Forget the oldest disconnected session
    if(this.#sessions.size > MAX_SESSIONS) {
      for(let [key, { sockets }] of this.#sessions) {
        if(sockets.size === 0) {
          this.#sessions.delete(key);
          break;
        }
      }
    }
    return session;
  }

  #receive(session, ws, message) {
    let { id } = message;
    let reply = session.replies.get(id);
    if(!reply) {
      reply = Promise.resolve()
        .then(() => this.#options.onMessage({ id, type: message.type, data: message.data, timestamp: message.timestamp, clientId: session.id }))
        .then(
          (data) => ({ type: "buildawesome.reply", id, ok: true, data }),
          (error) => ({ type: "buildawesome.reply", id, ok: false, error: { message: error?.message || String(error) } }),
        );
      session.replies.set(id, reply);
      if(session.replies.size > REPLY_CACHE_SIZE) {
        session.replies.delete(session.replies.keys().next().value);
      }
    }

    reply.then((obj) => {
      // A message resent after a reconnect gets its reply on the new socket instead
      if(ws.readyState !== ws.OPEN) {
        return;
      }
      let json;
      try {
        json = JSON.stringify(obj);
      } catch(e) {
        json = JSON.stringify({ type: "buildawesome.reply", id, ok: false, error: { message: `Reply could not be serialized: ${e.message}` } });
      }
      ws.send(json);
    });
  }

  /**
   * @param {string} json
   * @param {{ clientId?: string }} [options]
   */
  send(json, { clientId } = {}) {
    for(let session of this.#sessions.values()) {
      if(clientId && session.id !== clientId) {
        continue;
      }
      for(let ws of session.sockets) {
        if(ws.readyState === ws.OPEN) {
          ws.send(json);
        }
      }
    }
  }

  #ping() {
    for(let ws of this.#wss?.clients || []) {
      let state = this.#states.get(ws);
      if(state && !state.alive) {
        ws.terminate();
        continue;
      }
      if(state) {
        state.alive = false;
      }
      ws.ping();
    }
  }

  close() {
    clearInterval(this.#pingTimer);
    for(let ws of this.#wss?.clients || []) {
      ws.close(CLOSE_GOING_AWAY, "Server closing");
      // `close()` waits for the client to answer; `terminate()` doesn’t
      setTimeout(() => ws.terminate(), POLITE_CLOSE_TIMEOUT).unref?.();
    }
    this.#wss?.close();
  }
}
