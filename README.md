<p align="center"><img src="https://www.11ty.dev/img/logo-github.svg" width="200" height="200" alt="11ty Logo"></p>

# eleventy-dev-server 🕚⚡️🎈🐀

A minimal, modern, generic, hot-reloading local web server to help web developers.

## ➡ [Documentation](https://www.11ty.dev/docs/watch-serve/#eleventy-dev-server)

- Please star [Eleventy on GitHub](https://github.com/11ty/eleventy/)!
- [![npm Version](https://img.shields.io/npm/v/@11ty/eleventy-dev-server.svg?style=for-the-badge)](https://www.npmjs.com/package/@11ty/eleventy-dev-server)

## Installation

This is bundled with `@11ty/eleventy` (and you do not need to install it separately) in Eleventy v2.0 and newer.

## CLI

Eleventy Dev Server now also includes a CLI. The CLI is for **standalone** (non-Eleventy) use only: separate installation is _unnecessary_ if you’re using this server with `@11ty/eleventy`.

```sh
npm install -g @11ty/eleventy-dev-server

# Alternatively, install locally into your project
npm install @11ty/eleventy-dev-server
```

This package requires Node 22.15 or newer.

### CLI Usage

```sh
# Serve the current directory
npx @11ty/eleventy-dev-server

# Serve a different subdirectory (also aliased as --input)
npx @11ty/eleventy-dev-server --dir=_site

# Or pass the directory as an argument
npx @11ty/eleventy-dev-server _site

# Allow access from other devices on your network
npx @11ty/eleventy-dev-server --host=0.0.0.0

# Disable the `domdiff` feature
npx @11ty/eleventy-dev-server --no-domdiff

# Full command list in the Help
npx @11ty/eleventy-dev-server --help
```

## Server thread

The HTTP server runs on a worker thread by default, so requests stay fast even while a large
Eleventy build is occupying the main thread. Without it, request latency matches the longest
uninterrupted synchronous stretch of the build — a build rendering in 200ms chunks makes every
request wait ~200ms.

Static files, redirects, 404s and the injected client scripts are served entirely from the server
thread and never touch the main thread. Requests that need your code (`middleware` and `onRequest`,
which are closures and cannot cross a thread boundary) are handed to the main thread, so those are
no faster than before — but no slower either.

Opt out with:

```js
{
  serverThread: false
}
```

## Network access

The server only listens on `127.0.0.1`, so other devices can't reach it. To open it from a phone or another machine, listen on every interface:

```js
{
  host: "0.0.0.0"
}
```

The start message then lists the network addresses too (turn that off with `showAllHosts: false`).

## Case sensitivity

URLs must match the case of files on disk, like most production servers, so `/About/` is a 404 when the file is `about/index.html`. This only changes anything on case-insensitive file systems (the macOS and Windows defaults). Opt out with:

```js
{
  caseSensitive: false
}
```

## Reverse proxies

Behind a reverse proxy that serves the site under a path, set `pathPrefix` to that path: the injected scripts and the live reload connection use it too. The proxy needs to forward WebSocket upgrades, and either keep the `Host` header or have its hostname in `allowedHosts`.

## Allowed hosts

Live reload only accepts connections from pages served by the dev server, on `localhost`, `*.localhost`, or an IP address. Add any other hostname you use (e.g. from `/etc/hosts` or a proxy that keeps the `Host` header), with a leading `.` to include subdomains:

```js
{
  allowedHosts: ["mysite.test", ".example.test"]
}
```

`allowedHosts: true` allows any hostname, which drops protection against DNS rebinding.

## Client API

The injected client is available as `window.BuildAwesomeReload` (alias `window.EleventyReload`; `sendToServer(type, data)` returns `{ id }`) and dispatches these events on `document`:

- `buildawesome:reload` after every rebuild (including in-place morphdom patches), with `detail: { buildId, changed }`. `changed` is `false` when the rebuild didn’t touch the current page.
- `buildawesome:edit` for edit replies from the server, with `detail` set to the full message: `{ type, id, ok: true, results }` or `{ type, id, ok: false, errors }`. Match `id` against the one returned by `sendToServer`.

```js
document.addEventListener("buildawesome:reload", (e) => console.log(e.detail.buildId, e.detail.changed));
```

Add `data-buildawesome-preserve` to an element to keep morphdom from updating or removing it (and its children) during in-place updates (a full page reload still replaces it).

```html
<div data-buildawesome-preserve><!-- client-rendered content --></div>
```

## Tests

```
npm run test
```

- We use the [ava JavaScript test runner](https://github.com/avajs/ava) ([Assertions documentation](https://github.com/avajs/ava/blob/master/docs/03-assertions.md))

## Changelog

- `v3.0.0`
  - _Breaking-ish:_ Runs the HTTP server on a worker thread by default (opt out with `serverThread: false`) so server doesn’t hang when build is taking lots of resources. Using middleware reverts to previous behavior.
  - _Breaking:_ Dev server now only listens on `127.0.0.1` by default (set `host: "0.0.0.0"` for broader network access)
  - _Breaking:_ URLs must match the case of files on disk to match strictest case-sensitive servers (opt out with `caseSensitive: false`)
  - Live reload only accepts connections from pages on `localhost`, IP addresses, or hostnames in `allowedHosts`
  - Similar to `404.html`, adds support for `500.html` in the output folder (used for server errors)
  - `pathPrefix` now applies to injected client path and live reload connection
  - Adds `data-buildawesome-preserve` attribute to opt-out of `domDiff` for specific DOM nodes
  - Adds TypeScript types
  - _Breaking:_ Drops support for CLI `--domdiff=false`: use `--no-domdiff` instead.
  - _Breaking:_ Bumps Node.js minimum to 22.15
  - _Breaking:_ [`chokidar@4` drops support for globs in `watch` option](https://github.com/paulmillr/chokidar#upgrading)
- `v2.0.0`
  - Bumps Node.js minimum to 18