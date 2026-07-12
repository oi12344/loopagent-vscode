import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { CODE_EXPLORATION_QUESTION, evaluateCodeExploration } = require(
  "../scripts/codeExplorationE2e.js",
) as {
  CODE_EXPLORATION_QUESTION: string;
  evaluateCodeExploration(result: { process: string; answer: string }): {
    passed: boolean;
    matchedAnchors: string[];
    matchedPaths: string[];
    missingStates: string[];
  };
};

const expectedQuestion =
  "谁负责把代码上下文加入模型请求？请列出关键源码文件和函数。";

describe("code exploration E2E oracle", () => {
  it("asks the fixed entry-only question without leaking downstream anchors", () => {
    expect(CODE_EXPLORATION_QUESTION).toBe(expectedQuestion);
    expect(CODE_EXPLORATION_QUESTION).not.toContain("createConfiguredAgentRunner");
    expect(CODE_EXPLORATION_QUESTION).not.toContain("buildCodeIntelligencePrompt");
  });

  it("accepts required states, three anchors, and two real source paths", () => {
    const result = evaluateCodeExploration({
      process: "Planning step 1\nRunning tool exploreCode\nPlanning step 2\nDone",
      answer: [
        "`src/extension/runtime/vscodeRuntimeContext.ts` calls collectVsCodeRuntimeContext.",
        "`src/extension/runtime/codeRuntimeContext.ts` implements collectCodeRuntimeContext.",
        "`src/extension/runtime/contextPrompt.ts` invokes renderCodeRuntimeContextPrompt.",
      ].join("\n"),
    });

    expect(result).toEqual({
      passed: true,
      matchedAnchors: [
        "collectVsCodeRuntimeContext",
        "collectCodeRuntimeContext",
        "renderCodeRuntimeContextPrompt",
      ],
      matchedPaths: [
        "src/extension/runtime/vscodeRuntimeContext.ts",
        "src/extension/runtime/codeRuntimeContext.ts",
        "src/extension/runtime/contextPrompt.ts",
      ],
      missingStates: [],
    });
  });

  it("rejects a Done-only generic answer", () => {
    const result = evaluateCodeExploration({
      process: "Done",
      answer: "The extension builds context and uses the configured model.",
    });

    expect(result.passed).toBe(false);
    expect(result.matchedAnchors).toEqual([]);
    expect(result.matchedPaths).toEqual([]);
    expect(result.missingStates).toEqual([
      "Planning step 1",
      "Running tool exploreCode",
      "Planning step 2",
    ]);
  });

  it("rejects an otherwise semantic answer with only one source path", () => {
    const result = evaluateCodeExploration({
      process: "Planning step 1\nRunning tool exploreCode\nPlanning step 2\nDone",
      answer:
        "src/extension/runtime/vscodeRuntimeContext.ts links collectVsCodeRuntimeContext, collectCodeRuntimeContext, and renderCodeRuntimeContextPrompt.",
    });

    expect(result.passed).toBe(false);
    expect(result.matchedAnchors).toHaveLength(3);
    expect(result.matchedPaths).toEqual([
      "src/extension/runtime/vscodeRuntimeContext.ts",
    ]);
  });

  it("rejects two paths when neither is a required intelligence implementation", () => {
    const result = evaluateCodeExploration({
      process: "Planning step 1\nRunning tool exploreCode\nPlanning step 2\nDone",
      answer: [
        "src/extension.ts calls collectVsCodeRuntimeContext.",
        "src/extension/chat/LoopAgentChatViewProvider.ts mentions collectCodeRuntimeContext and renderCodeRuntimeContextPrompt.",
      ].join("\n"),
    });

    expect(result.passed).toBe(false);
    expect(result.matchedPaths).toHaveLength(2);
  });

  it("normalizes markdown backslashes and deduplicates anchors and paths", () => {
    const result = evaluateCodeExploration({
      process: "Planning step 1\nRunning tool exploreCode\nPlanning step 2\nDone",
      answer: [
        "`src\\extension\\runtime\\vscodeRuntimeContext.ts`,, uses collectVsCodeRuntimeContext and collectCodeRuntimeContext.",
        "src/extension/runtime/vscodeRuntimeContext.ts... collectCodeRuntimeContext.",
        "**src\\extension\\runtime\\contextPrompt.ts** connects renderCodeRuntimeContextPrompt.",
      ].join("\n"),
    });

    expect(result.passed).toBe(true);
    expect(result.matchedAnchors).toEqual([
      "collectVsCodeRuntimeContext",
      "collectCodeRuntimeContext",
      "renderCodeRuntimeContextPrompt",
    ]);
    expect(result.matchedPaths).toEqual([
      "src/extension/runtime/vscodeRuntimeContext.ts",
      "src/extension/runtime/contextPrompt.ts",
    ]);
  });

  it("deduplicates tool anchors and rejects a tsx path prefix", () => {
    const result = evaluateCodeExploration({
      process: "Planning step 1\nRunning tool exploreCode\nPlanning step 2\nDone",
      answer: [
        "src/extension/model/providerRegistry.ts",
        "src/extension/not-real.tsx",
        "collectVsCodeRuntimeContext collectVsCodeRuntimeContext",
      ].join("\n"),
    });

    expect(result.passed).toBe(false);
    expect(result.matchedAnchors).toEqual(["collectVsCodeRuntimeContext"]);
    expect(result.matchedPaths).toEqual([
      "src/extension/model/providerRegistry.ts",
    ]);
  });
});

describe("code exploration CDP runner contract", () => {
  const readRunner = () =>
    readFileSync(
      resolve(process.cwd(), "scripts/run-code-exploration-e2e.mjs"),
      "utf8",
    );

  it("does not read or print the DeepSeek secret", () => {
    const runner = readRunner();
    expect(runner).not.toContain("DEEPSEEK_API_KEY");
    expect(runner).not.toContain("Authorization");
  });

  it("pins the isolated CDP endpoint, timeout, screenshot, and activity entry", () => {
    const runner = readRunner();
    expect(runner).toContain("const CDP_PORT = 9333");
    expect(runner).toContain("const WAIT_TIMEOUT_MS = 120_000");
    expect(runner).toContain("code-exploration-e2e.png");
    expect(runner).toContain('getAttribute("aria-label") === "LoopAgent"');
    expect(runner).toContain('getAttribute("aria-selected") !== "true"');
    expect(runner).toContain("activityEntry.click()");
    expect(runner).toContain("workbench.html");
    expect(runner).toContain("vscode-webview");
  });

  it("uses the real Webview composer and assistant result selectors", () => {
    const runner = readRunner();
    expect(runner).toContain('getElementById("active-frame")');
    expect(runner).toContain("contentDocument ?? document");
    expect(runner).toContain("webviewDocument.defaultView");
    expect(runner).toContain("DeepSeek v4 Flash");
    expect(runner).toContain("#message-input");
    expect(runner).toContain('form.chat-composer button[type="submit"]');
    expect(runner).toContain("HTMLTextAreaElement.prototype");
    expect(runner).toContain(".message-assistant");
    expect(runner).toContain(".process-details");
    expect(runner).toContain(".assistant-answer");
    expect(runner).toContain('[role="alert"]');
  });

  it("keeps expected answer anchors out of the runner", () => {
    const runner = readRunner();
    expect(runner).not.toContain("createConfiguredAgentRunner");
    expect(runner).not.toContain("buildCodeIntelligencePrompt");
  });

  it("waits for an assistant turn created by the current submission", () => {
    const runner = readRunner();
    expect(runner).toContain("assistantTurnCount");
    expect(runner).toContain('turns.length <= ${previousTurnCount}');
  });

  it("prefers a LoopAgent target over a generic VS Code Webview", () => {
    const runner = readRunner();
    expect(runner).toContain('identity.includes("loopagent") ? 0 : 1');
  });
});
