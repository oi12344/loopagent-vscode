import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("VS Code debug script", () => {
  it("opens the extension project root as the debug workspace folder", () => {
    const script = readFileSync(resolve(process.cwd(), "scripts/start-vscode-debug.ps1"), "utf8");

    expect(script).toContain('"--extensionDevelopmentPath=$extensionPath"');
    expect(script).toContain('"$extensionPath"');
  });
});
