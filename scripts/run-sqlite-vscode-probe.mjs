import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
