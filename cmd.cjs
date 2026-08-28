#!/usr/bin/env node

const pkg = require("./package.json");

// Node check
require("@11ty/node-version-check")(pkg, {
  message: function (requiredVersion) {
    return (
      "eleventy-dev-server requires Node " +
      requiredVersion +
      ". You will need to upgrade Node!"
    );
  },
});

const { Logger, Cli } = require("./cli.js");

try {
  const defaults = Cli.getDefaultOptions();

  const { parseArgs } = require("node:util");

  const args = process.argv.slice(2);
  const options = {
    dir: {
      type: "string",
    },
    input: {
      type: "string",
      default: defaults.input,
    },
    port: {
      type: "string",
      default: defaults.port,
    },
    domdiff: {
      type: "boolean",
      default: defaults.domDiff,
    },
    help: {
      type: "boolean",
      default: false,
    },
    version: {
      type: "boolean",
      default: false,
    },
  };

  const { values: argv } = parseArgs({ args, options });

  // Older Node friendly import workaround (this is a CommonJS file)
  import("obug").then(({ createDebug }) => {
    const debug = createDebug("Eleventy:DevServer");
    debug("CLI arguments: %o", argv);
  });

  process.on("unhandledRejection", (error, promise) => {
    Logger.fatal("Unhandled rejection in promise:", promise, error);
  });
  process.on("uncaughtException", (error) => {
    Logger.fatal("Uncaught exception:", error);
  });

  if (argv.version) {
    console.log(Cli.getVersion());
  } else if (argv.help) {
    console.log(Cli.getHelp());
  } else {
    let cli = new Cli();

    cli.serve({
      input: argv.dir || argv.input,
      port: argv.port,
      domDiff: argv.domdiff,
    });

    process.on("SIGINT", async () => {
      await cli.close();
      process.exitCode = 0;
    });
  }
} catch (e) {
  if (e instanceof TypeError) {
    const unknownArgument = e.message.split(" ").pop();

    e = new Error(
      `We don’t know what ${unknownArgument} is. Use --help to see the list of supported commands.`
    );
  }

  Logger.fatal("Fatal Error:", e)
}
