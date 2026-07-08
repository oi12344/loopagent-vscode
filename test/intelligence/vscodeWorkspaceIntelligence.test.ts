import { describe, expect, it } from "vitest";

import {
  createVsCodeWorkspaceIntelligence,
  detectWorkspaceLanguageId,
  isIndexableWorkspacePath,
  normalizeWorkspaceRelativePath,
  readSourceRangeFromText,
  type VsCodeWorkspaceApi,
} from "../../src/extension/intelligence/vscodeWorkspaceIntelligence";

describe("isIndexableWorkspacePath", () => {
  it("excludes generated, hidden, and secret-like paths", () => {
    expect(isIndexableWorkspacePath("node_modules/react/index.js")).toBe(false);
    expect(isIndexableWorkspacePath("dist/extension.js")).toBe(false);
    expect(isIndexableWorkspacePath(".git/config")).toBe(false);
    expect(isIndexableWorkspacePath(".local-vscode-user-data/User/settings.json")).toBe(false);
    expect(isIndexableWorkspacePath(".env")).toBe(false);
    expect(isIndexableWorkspacePath(".env.local")).toBe(false);
    expect(isIndexableWorkspacePath("secrets/api-token.txt")).toBe(false);
    expect(isIndexableWorkspacePath("config/api_key.json")).toBe(false);
  });

  it("keeps normal source paths and normalizes Windows separators", () => {
    expect(isIndexableWorkspacePath("src/extension.ts")).toBe(true);
    expect(isIndexableWorkspacePath("src\\extension.ts")).toBe(true);
    expect(isIndexableWorkspacePath("node_modules\\react\\index.js")).toBe(false);
  });
});

describe("VS Code workspace source helpers", () => {
  it("detects supported source languages from workspace paths", () => {
    expect(detectWorkspaceLanguageId("src/extension.ts")).toBe("typescript");
    expect(detectWorkspaceLanguageId("src/App.tsx")).toBe("typescriptreact");
    expect(detectWorkspaceLanguageId("scripts/tool.js")).toBe("javascript");
    expect(detectWorkspaceLanguageId("scripts/tool.jsx")).toBe("javascriptreact");
    expect(detectWorkspaceLanguageId("tools/index.py")).toBe("python");
    expect(detectWorkspaceLanguageId("README.md")).toBeUndefined();
  });

  it("normalizes absolute paths against workspace roots", () => {
    expect(normalizeWorkspaceRelativePath("E:\\work\\repo\\src\\extension.ts", ["E:\\work\\repo"])).toBe(
      "src/extension.ts",
    );
    expect(normalizeWorkspaceRelativePath("/work/repo/src/extension.ts", ["/work/repo"])).toBe("src/extension.ts");
  });

  it("reads one-based inclusive source ranges", () => {
    expect(readSourceRangeFromText("a\nb\nc\nd", 2, 3)).toBe("b\nc");
    expect(readSourceRangeFromText("a\nb", -5, 99)).toBe("a\nb");
  });
});

describe("createVsCodeWorkspaceIntelligence", () => {
  it("builds a code intelligence prompt from real workspace files and excludes secrets", async () => {
    const workspaceRoot = "E:\\work\\repo";
    const files = new Map<string, string>([
      [
        `${workspaceRoot}\\src\\modelAccess.ts`,
        [
          "export function createDeepSeekProvider() {",
          "  return { provider: \"deepseek\" };",
          "}",
          "",
        ].join("\n"),
      ],
      [`${workspaceRoot}\\.env`, "DEEPSEEK_API_KEY=should-not-be-indexed"],
    ]);

    const intelligence = createVsCodeWorkspaceIntelligence(createFakeVsCodeWorkspaceApi(workspaceRoot, files), {
      maxWorkspaceFiles: 20,
      maxFileBytes: 100_000,
    });

    const prompt = await intelligence.buildCodeIntelligencePrompt("模型接入 createDeepSeekProvider");

    expect(prompt).toContain("代码语义索引上下文");
    expect(prompt).toContain("createDeepSeekProvider");
    expect(prompt).toContain("src/modelAccess.ts");
    expect(prompt).not.toContain("DEEPSEEK_API_KEY");
    expect(intelligence.getStatus()).toBe("ready");
  });
});

function createFakeVsCodeWorkspaceApi(workspaceRoot: string, files: Map<string, string>): VsCodeWorkspaceApi {
  const uris = [...files.keys()].map((fsPath) => ({ fsPath }));

  return {
    workspace: {
      workspaceFolders: [{ uri: { fsPath: workspaceRoot }, name: "repo", index: 0 }],
      findFiles: async () => uris,
      fs: {
        readFile: async (uri) => new TextEncoder().encode(files.get(uri.fsPath) ?? ""),
      },
      asRelativePath: (uriOrPath) =>
        normalizeWorkspaceRelativePath(typeof uriOrPath === "string" ? uriOrPath : uriOrPath.fsPath, [workspaceRoot]),
    },
  };
}
