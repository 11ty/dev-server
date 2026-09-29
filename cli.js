import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import DevServer from "./server.js";

const require = createRequire(import.meta.url);
const pkg = require("./package.json");

export const Logger = {
  info(...args) {
    console.log( "[11ty/eleventy-dev-server]", ...args );
  },
  error(...args) {
    console.error( "[11ty/eleventy-dev-server]", ...args );
  },
  fatal(...args) {
    Logger.error(...args);
    process.exitCode = 1;
  },
  log(...args) {
    return Logger.info(...args);
  }
};

export class Cli {
  static getVersion() {
    return pkg.version;
  }

  static getHelp() {
    return `Usage:

     eleventy-dev-server [dir] [options]

Examples:

     eleventy-dev-server
     eleventy-dev-server _site
     eleventy-dev-server --dir=_site --port=3000

Options:

     --dir=.
       Directory to serve (default: \`.\`), or pass it as the first argument.

     --input (alias for --dir)

     --port=8080
       Run the web server on this port (default: \`8080\`)
       Will autoincrement if already in use.

     --domdiff          (enabled, default)
     --no-domdiff       (disabled)
       Apply HTML changes without a full page reload.

     --version

     --help`;
  }

  static parseArgs(args = []) {
    let defaults = Cli.getDefaultOptions();
    let { values, positionals } = parseArgs({
      args,
      allowNegative: true,
      allowPositionals: true,
      options: {
        dir: { type: "string" },
        input: { type: "string" },
        port: { type: "string", default: defaults.port },
        domdiff: { type: "boolean", default: defaults.domDiff },
        help: { type: "boolean", default: false },
        version: { type: "boolean", default: false },
      },
    });

    let usageError = (message) => {
      let error = new Error(message);
      // Printed without a stack trace, like Node's own argument errors
      error.code = "ERR_PARSE_ARGS_DIRECTORY";
      return error;
    };

    if(positionals.length > 1) {
      throw usageError(`Expected one directory, received ${positionals.length}: ${positionals.join(", ")}.`);
    }

    let [dir] = positionals;
    if(dir !== undefined && (values.dir !== undefined || values.input !== undefined)) {
      throw usageError("Pass the directory either as an argument or with --dir, not both.");
    }

    return {
      ...values,
      dir: dir ?? values.dir ?? values.input ?? defaults.input,
    };
  }

  static getDefaultOptions() {
    return {
      port: "8080",
      input: ".",
      domDiff: true,
    }
  }

  async serve(options = {}) {
    this.options = Object.assign(Cli.getDefaultOptions(), options);

    this.server = DevServer.getServer("eleventy-dev-server-cli", this.options.input, {
      // TODO allow server configuration extensions
      showVersion: true,
      logger: Logger,
      domDiff: this.options.domDiff,

      // CLI watches all files in the folder by default
      // this is different from Eleventy usage!
      watch: [ this.options.input ],
    });

    this.server.serve(this.options.port);

    // TODO? send any errors here to the server too
    // with server.sendError({ error });
  }

  close() {
    if(this.server) {
      return this.server.close();
    }
  }
}
