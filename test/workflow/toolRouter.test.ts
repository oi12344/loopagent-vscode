import { describe, expect, it } from "vitest";

import type { ReactAgentTool } from "../../src/extension/agent/reactTypes";
import { selectTools } from "../../src/extension/agent/workflow/toolRouter";

const tools: ReactAgentTool[] = [
  tool("readFile", "Read text file contents from the workspace."),
  tool("applyEdit", "Propose and apply a workspace edit."),
  tool("exploreCode", "Search code in the current repository."),
  tool("runCommand", "Run an approved shell command."),
];

describe("ToolRouter", () => {
  it("uses explicit tool hints before task matching while preserving tool order", () => {
    expect(names(selectTools("read the settings file", tools, ["exploreCode", "applyEdit"]))).toEqual([
      "applyEdit",
      "exploreCode",
    ]);
  });

  it("matches task words against a tool description", () => {
    expect(names(selectTools("read the configuration file", tools))).toEqual(["readFile"]);
  });

  it("does not auto-select exploreCode for ordinary analysis tasks", () => {
    expect(names(selectTools("analyze the codebase", tools))).toEqual(["readFile"]);
  });

  it("uses readFile for an unknown task and the first tool when readFile is unavailable", () => {
    expect(names(selectTools("xyz abc 123", tools))).toEqual(["readFile"]);
    expect(names(selectTools("xyz abc 123", tools.slice(1)))).toEqual(["applyEdit"]);
  });

  it("returns no tools when none are available", () => {
    expect(selectTools("read a file", [])).toEqual([]);
  });

  it("restricts selection to the role whitelist before applying hints", () => {
    expect(names(selectTools("read the settings file", tools, ["exploreCode", "applyEdit"], ["exploreCode", "readFile"]))).toEqual([
      "exploreCode",
    ]);
  });

  it("falls back within the role whitelist when the task only matches an excluded tool", () => {
    expect(names(selectTools("propose an edit", tools, undefined, ["exploreCode", "readFile"]))).toEqual(["readFile"]);
  });

  it("restricts the fallback tool to the role whitelist", () => {
    expect(names(selectTools("xyz abc 123", tools, undefined, ["exploreCode", "readFile"]))).toEqual(["readFile"]);
  });

  it("returns no tools when the role whitelist excludes everything available", () => {
    expect(selectTools("read a file", tools, undefined, ["nonexistentTool"])).toEqual([]);
  });
});

function names(selected: ReactAgentTool[]): string[] {
  return selected.map((tool) => tool.name);
}

function tool(name: string, description: string): ReactAgentTool {
  return {
    name,
    description,
    inputSchema: {},
    invoke: () => "",
  };
}
