const picomatch = require("picomatch");
const { TemplatePath } = require("@11ty/eleventy-utils");

// Same as the previous chokidar 3 `ignored: ["**/node_modules/**", ".git"]`
const isAlwaysIgnored = picomatch(["**/node_modules/**", ".git", ".git/**"], { dot: true });

function normalize(filePath) {
  let normalized = TemplatePath.stripLeadingDotSlash(filePath.replace(/\\/g, "/"));
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

// chokidar 4 dropped glob support: watch each glob's base directory and filter with picomatch.
class WatchTargets {
  #paths = [];
  #globs = [];
  #negations = [];

  // Returns the paths to pass to chokidar
  add(entries = []) {
    let paths = [];
    for(let entry of entries) {
      entry = normalize(entry);
      let { isGlob, negated, base } = picomatch.scan(entry);
      if(negated) {
        this.#negations.push(picomatch(entry.slice(1), { dot: true }));
      } else if(isGlob) {
        this.#globs.push(picomatch(entry, { dot: true }));
        paths.push(base || ".");
      } else {
        this.#paths.push(entry);
        paths.push(entry);
      }
    }
    return paths;
  }

  isWatched(filePath) {
    filePath = normalize(filePath);
    if(this.#negations.some(isMatch => isMatch(filePath))) {
      return false;
    }
    return this.#paths.some(p => p === "." || filePath === p || filePath.startsWith(`${p}/`))
      || this.#globs.some(isMatch => isMatch(filePath));
  }

  // chokidar `ignored` callback, directories are always traversed
  isIgnored(filePath, stats) {
    if(isAlwaysIgnored(normalize(filePath))) {
      return true;
    }
    return Boolean(stats?.isFile()) && !this.isWatched(filePath);
  }
}

module.exports = WatchTargets;
