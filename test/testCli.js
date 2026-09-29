import test from "ava";
import { Cli } from "../cli.js";

function parse(args) {
  let { dir, input, port, domdiff, help, version } = Cli.parseArgs(args);
  return { dir, input, port, domdiff, help, version };
}

test("Defaults", (t) => {
  t.deepEqual(parse([]), { dir: ".", input: undefined, port: "8080", domdiff: true, help: false, version: false });
});

test("String options", (t) => {
  t.is(parse(["--port=3000"]).port, "3000");
  t.is(parse(["--port", "3000"]).port, "3000");
  t.is(parse(["--input=src"]).dir, "src");
  t.is(parse(["--dir=_site"]).dir, "_site");
  t.is(parse(["--dir=_site", "--input=src"]).dir, "_site");
});

test("Boolean flags", (t) => {
  t.false(parse(["--no-domdiff"]).domdiff);
  t.true(parse(["--domdiff"]).domdiff);
  t.true(parse(["--help"]).help);
  t.true(parse(["--version"]).version);
});

test("Invalid arguments throw parseArgs errors", (t) => {
  t.throws(() => Cli.parseArgs(["--foo"]), { code: "ERR_PARSE_ARGS_UNKNOWN_OPTION" });
  t.throws(() => Cli.parseArgs(["--port"]), { code: "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" });
  // `--domdiff=false` was removed in v3 in favor of `--no-domdiff`
  t.throws(() => Cli.parseArgs(["--domdiff=false"]), { code: "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" });
});

test("Directory as an argument", (t) => {
  t.is(parse(["_site"]).dir, "_site");
  t.deepEqual(parse(["_site", "--port=3000"]), { ...parse([]), dir: "_site", port: "3000" });
  t.is(parse(["--no-domdiff", "_site"]).dir, "_site");
});

test("Directory argument conflicts", (t) => {
  t.throws(() => Cli.parseArgs(["_site", "src"]), { code: "ERR_PARSE_ARGS_DIRECTORY", message: "Expected one directory, received 2: _site, src." });
  t.throws(() => Cli.parseArgs(["_site", "--dir=src"]), { code: "ERR_PARSE_ARGS_DIRECTORY" });
  t.throws(() => Cli.parseArgs(["_site", "--input=src"]), { code: "ERR_PARSE_ARGS_DIRECTORY" });
});
