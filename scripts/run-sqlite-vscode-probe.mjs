import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const { sqliteProbeTestConfig, sqliteWorkerConfig } = require("../esbuild.js");

await Promise.all([
  esbuild.build(sqliteWorkerConfig),
  esbuild.build(sqliteProbeTestConfig),
]);

delete process.env.ELECTRON_RUN_AS_NODE;

await runTests({
  version: "1.103.0",
  extensionDevelopmentPath: root,
  extensionTestsPath: path.join(
    root,
    "dist/test/sqliteCapabilityExtension.test.js",
  ),
  launchArgs: [
    path.join(root, "test/fixtures/sqlite-probe"),
    "--disable-extensions",
  ],
});
