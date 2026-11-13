import test from "node:test";
import assert from "node:assert/strict";
import { Cli } from "../cli.js";

function parse(args) {
  let { dir, input, port, host, domdiff, help, version } = Cli.parseArgs(args);
  return { dir, input, port, host, domdiff, help, version };
}

test("Defaults", () => {
  assert.deepEqual(parse([]), { dir: ".", input: undefined, port: "8080", host: undefined, domdiff: true, help: false, version: false });
});

test("String options", () => {
  assert.equal(parse(["--port=3000"]).port, "3000");
  assert.equal(parse(["--port", "3000"]).port, "3000");
  assert.equal(parse(["--input=src"]).dir, "src");
  assert.equal(parse(["--dir=_site"]).dir, "_site");
  assert.equal(parse(["--host=0.0.0.0"]).host, "0.0.0.0");
  assert.equal(parse([]).host, undefined);
  assert.equal(parse(["--dir=_site", "--input=src"]).dir, "_site");
});

test("Boolean flags", () => {
  assert.equal(parse(["--no-domdiff"]).domdiff, false);
  assert.ok(parse(["--domdiff"]).domdiff);
  assert.ok(parse(["--help"]).help);
  assert.ok(parse(["--version"]).version);
});

test("Invalid arguments throw parseArgs errors", () => {
  assert.throws(() => Cli.parseArgs(["--foo"]), { code: "ERR_PARSE_ARGS_UNKNOWN_OPTION" });
  assert.throws(() => Cli.parseArgs(["--port"]), { code: "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" });
  // `--domdiff=false` was removed in v3 in favor of `--no-domdiff`
  assert.throws(() => Cli.parseArgs(["--domdiff=false"]), { code: "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" });
});

test("Directory as an argument", () => {
  assert.equal(parse(["_site"]).dir, "_site");
  assert.deepEqual(parse(["_site", "--port=3000"]), { ...parse([]), dir: "_site", port: "3000" });
  assert.equal(parse(["--no-domdiff", "_site"]).dir, "_site");
});

test("Directory argument conflicts", () => {
  assert.throws(() => Cli.parseArgs(["_site", "src"]), { code: "ERR_PARSE_ARGS_DIRECTORY", message: "Expected one directory, received 2: _site, src." });
  assert.throws(() => Cli.parseArgs(["_site", "--dir=src"]), { code: "ERR_PARSE_ARGS_DIRECTORY" });
  assert.throws(() => Cli.parseArgs(["_site", "--input=src"]), { code: "ERR_PARSE_ARGS_DIRECTORY" });
});
