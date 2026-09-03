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

# Disable the `domdiff` feature
npx @11ty/eleventy-dev-server --domdiff=false

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

## Tests

```
npm run test
```

- We use the [ava JavaScript test runner](https://github.com/avajs/ava) ([Assertions documentation](https://github.com/avajs/ava/blob/master/docs/03-assertions.md))

## Changelog

- `v3.0.0` runs the HTTP server on a worker thread by default (opt out with `serverThread: false`), bumps Node.js minimum to 22.15, [`chokidar@4` drops support for globs in `watch` option](https://github.com/paulmillr/chokidar#upgrading)
- `v2.0.0` bumps Node.js minimum to 18.