import { describe, expect, it } from "vitest";

import {
  renderCodeRuntimeContextPrompt,
  type CodeRuntimeContext,
} from "../src/extension/runtime/contextPrompt";

describe("renderCodeRuntimeContextPrompt", () => {
  it("renders a compact prompt with workspace, active editor, selection, and project summaries", () => {
    const prompt = renderCodeRuntimeContextPrompt({
      version: 1,
      collectedAt: "2026-07-07T00:00:00.000Z",
      workspace: {
        name: "LoopAgent",
        roots: ["loopagent-vscode"],
      },
      activeEditor: {
        path: "src/shared/messages.ts",
        languageId: "typescript",
        lineCount: 20,
        cursor: { line: 3, character: 5 },
        selection: {
          startLine: 3,
          endLine: 4,
          text: "export type WebviewToHostMessage =",
          truncated: false,
        },
      },
      visibleEditors: [],
      openTabs: [
        {
          path: "README.md",
          languageId: "markdown",
          isDirty: false,
        },
      ],
      projectFiles: [
        {
          path: "package.json",
          kind: "manifest",
          summary: "name: loopagent-vscode\nscripts: test, compile",
          truncated: false,
        },
      ],
      diagnostics: [
        {
          path: "src/extension.ts",
          severity: "warning",
          line: 12,
          character: 3,
          message: "Unused import",
        },
      ],
      budget: {
        maxChars: 12_000,
        usedChars: 120,
        truncated: false,
      },
    });

    expect(prompt).toContain("当前 VS Code 工作区只读上下文");
    expect(prompt).toContain("名称: LoopAgent");
    expect(prompt).toContain("src/shared/messages.ts");
    expect(prompt).toContain("```typescript");
    expect(prompt).toContain("export type WebviewToHostMessage =");
    expect(prompt).toContain("package.json");
    expect(prompt).toContain("Unused import");
    expect(prompt).toContain("该上下文不是完整仓库");
  });

  it("returns an empty prompt when no useful context was collected", () => {
    const emptyContext: CodeRuntimeContext = {
      version: 1,
      collectedAt: "2026-07-07T00:00:00.000Z",
      workspace: {
        roots: [],
      },
      visibleEditors: [],
      openTabs: [],
      projectFiles: [],
      diagnostics: [],
      budget: {
        maxChars: 12_000,
        usedChars: 0,
        truncated: false,
      },
    };

    expect(renderCodeRuntimeContextPrompt(emptyContext)).toBe("");
  });
});
