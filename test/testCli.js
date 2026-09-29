import test from "ava";
import { Cli } from "../cli.js";

function parse(args) {
  let { dir, input, port, domdiff, help, version } = Cli.parseArgs(args);
  return { dir, input, port, domdiff, help, version };
}

test("Defaults", (t) => {
  t.deepEqual(parse([]), { dir: undefined, input: ".", port: "8080", domdiff: true, help: false, version: false });
});

test("String options", (t) => {
  t.is(parse(["--port=3000"]).port, "3000");
  t.is(parse(["--port", "3000"]).port, "3000");
  t.is(parse(["--input=src"]).input, "src");
  t.is(parse(["--dir=_site"]).dir, "_site");
});

test("Boolean flags", (t) => {
  t.false(parse(["--no-domdiff"]).domdiff);
  t.true(parse(["--domdiff"]).domdiff);
  t.true(parse(["--help"]).help);
  t.true(parse(["--version"]).version);
});

test("Invalid arguments throw parseArgs errors", (t) => {
  t.throws(() => Cli.parseArgs(["--foo"]), { code: "ERR_PARSE_ARGS_UNKNOWN_OPTION" });
  t.throws(() => Cli.parseArgs(["src"]), { code: "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL" });
  t.throws(() => Cli.parseArgs(["--port"]), { code: "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" });
  // `--domdiff=false` was removed in v3 in favor of `--no-domdiff`
  t.throws(() => Cli.parseArgs(["--domdiff=false"]), { code: "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" });
});
