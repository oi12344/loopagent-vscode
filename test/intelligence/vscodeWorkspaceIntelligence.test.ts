import { describe, expect, it } from "vitest";

import { isIndexableWorkspacePath } from "../../src/extension/intelligence/vscodeWorkspaceIntelligence";

describe("isIndexableWorkspacePath", () => {
  it("excludes generated, dependency, local debug, and sensitive paths", () => {
    expect(isIndexableWorkspacePath("src/extension.ts")).toBe(true);
    expect(isIndexableWorkspacePath("node_modules/react/index.js")).toBe(false);
    expect(isIndexableWorkspacePath("dist/extension.js")).toBe(false);
    expect(isIndexableWorkspacePath(".git/config")).toBe(false);
    expect(isIndexableWorkspacePath(".local-vscode-user-data/User/settings.json")).toBe(false);
    expect(isIndexableWorkspacePath(".env")).toBe(false);
    expect(isIndexableWorkspacePath(".env.local")).toBe(false);
    expect(isIndexableWorkspacePath("secrets/api-token.txt")).toBe(false);
    expect(isIndexableWorkspacePath("config/api_key.json")).toBe(false);
  });

  it("normalizes Windows paths before filtering", () => {
    expect(isIndexableWorkspacePath("src\\extension.ts")).toBe(true);
    expect(isIndexableWorkspacePath("node_modules\\react\\index.js")).toBe(false);
  });
});
