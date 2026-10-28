// A privileged connection to the dev server’s `ws` option: messages get replies, and the server can push events.
export class WsClient extends EventTarget {
  #url;
  #token;
  #socket;
  #authed = false;
  #closed = false;
  #sessionId = crypto.randomUUID();
  #pending = new Map(); // unanswered messages, resent after a reconnect (the server replies to repeats from its cache)
  #reconnectInterval;
  #reconnectTimer;

  static RECONNECT_INTERVAL = 2000; // ms
  static MAX_RECONNECT_INTERVAL = 5000; // ms
  static MAX_QUEUE = 100; // messages held while disconnected
  static CLOSE_AUTH_FAILED = 4401;

  // Next to this script so `pathPrefix` is kept.
  static getSocketUrl(scriptHref) {
    let url = new URL("ws", scriptHref);
    url.protocol = url.protocol.replace("http", "ws");
    return url.toString();
  }

  /** @param {{ token: string, url?: string }} options */
  constructor({ token, url }) {
    super();
    this.#token = token;
    this.#url = url || WsClient.getSocketUrl(import.meta.url);
    this.#reconnectInterval = WsClient.RECONNECT_INTERVAL;
    this.#connect();
  }

  // Matches `clientId` in the server’s `ws.onMessage`.
  get clientId() {
    return this.#sessionId;
  }

  #connect() {
    let socket = new WebSocket(this.#url);
    this.#socket = socket;

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "auth", token: this.#token, sessionId: this.#sessionId }));
    });
    socket.addEventListener("message", (event) => this.#onMessage(event));
    socket.addEventListener("close", (event) => this.#onClose(event));
  }

  #onMessage(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch(e) {
      return;
    }

    if(message?.type === "buildawesome.auth") {
      this.#authed = true;
      this.#reconnectInterval = WsClient.RECONNECT_INTERVAL;
      for(let { json } of this.#pending.values()) {
        this.#socket.send(json);
      }
      this.dispatchEvent(new CustomEvent("open"));
    } else if(message?.type === "buildawesome.reply") {
      let entry = this.#pending.get(message.id);
      if(entry) {
        this.#pending.delete(message.id);
        if(message.ok) {
          entry.resolve(message.data);
        } else {
          entry.reject(new Error(message.error?.message));
        }
      }
    } else if(typeof message?.type === "string") {
      this.dispatchEvent(new CustomEvent(message.type, { detail: message }));
    }
  }

  #onClose(event) {
    this.#authed = false;
    if(this.#closed) {
      return;
    }

    // Retrying a bad token would loop forever
    if(event.code === WsClient.CLOSE_AUTH_FAILED) {
      this.#closed = true;
      this.#rejectAll(new Error("Authentication failed."));
      this.dispatchEvent(new CustomEvent("authfailed"));
      return;
    }

    this.dispatchEvent(new CustomEvent("close"));
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectInterval = Math.min(this.#reconnectInterval * 2, WsClient.MAX_RECONNECT_INTERVAL);
      this.#connect();
    }, this.#reconnectInterval);
  }

  #rejectAll(error) {
    for(let { reject } of this.#pending.values()) {
      reject(error);
    }
    this.#pending.clear();
  }

  /**
   * Resolves with `ws.onMessage`’s result, or rejects with the error it threw.
   * @param {string} type
   * @param {unknown} [data]
   */
  send(type, data) {
    if(this.#closed) {
      return Promise.reject(new Error("Connection closed."));
    }

    let id = crypto.randomUUID();
    let json = JSON.stringify({ id, type, data, timestamp: Date.now() });

    return new Promise((resolve, reject) => {
      this.#pending.set(id, { json, resolve, reject });

      if(this.#authed) {
        this.#socket.send(json);
      } else if(this.#pending.size > WsClient.MAX_QUEUE) {
        let [oldestId, oldest] = /** @type {[string, any]} */ (this.#pending.entries().next().value);
        this.#pending.delete(oldestId);
        oldest.reject(new Error("Too many messages waiting to send."));
      }
    });
  }

  close() {
    this.#closed = true;
    clearTimeout(this.#reconnectTimer);
    this.#socket?.close();
    this.#rejectAll(new Error("Connection closed."));
  }
}
