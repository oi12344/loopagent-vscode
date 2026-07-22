const { readdirSync } = require("node:fs");
const { join, relative } = require("node:path");

function listSuperpowersResourcePaths(resourceRoot) {
  const paths = [];

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile()) {
        paths.push(relative(resourceRoot, entryPath).replaceAll("\\", "/"));
      }
    }
  }

  visit(resourceRoot);
  return paths.sort();
}

module.exports = { listSuperpowersResourcePaths };
