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
  const argv = Cli.parseArgs(process.argv.slice(2));

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
  if (e.code?.startsWith("ERR_PARSE_ARGS_")) {
    let message = e.message.endsWith(".") ? e.message : `${e.message}.`;
    Logger.fatal(`${message} Use --help to see the list of supported commands.`);
  } else {
    Logger.fatal("Fatal Error:", e)
  }
}
