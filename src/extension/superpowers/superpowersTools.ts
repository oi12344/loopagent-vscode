import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import type { ReactAgentTool } from "../agent/reactTypes";
import type { SkillCatalog } from "./superpowersTypes";
import type { ReviewResult, SubagentResult, SubagentStatus } from "./agentPool";

type BundledScriptsManifest = { scripts?: Record<string, string> };

export type CreateSuperpowersToolsOptions = {
  catalog: SkillCatalog;
  resourceRoot: string;
  findGitBash?: () => Promise<string | undefined>;
  execute?: (bashPath: string, scriptPath: string, args: string[], signal: AbortSignal) => Promise<string>;
  onSubagentResult?: (result: SubagentResult) => void;
  onReview?: (result: ReviewResult) => void;
};

export function createSuperpowersTools(options: CreateSuperpowersToolsOptions): ReactAgentTool[] {
  const scripts = readBundledScripts(options.resourceRoot);
  const corrections = new Set<string>();
  const rejectInvalidReport = (toolName: string) => {
    if (corrections.has(toolName)) throw new Error(`${toolName} result blocked after invalid correction`);
    corrections.add(toolName);
    throw new Error(`${toolName} result is invalid; correct it once`);
  };

  return [
    {
      name: "loadSkill",
      description: "Load a bundled Superpowers skill by name.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
      async invoke({ input }) {
        const name = getString(input, "name");
        return (await options.catalog.load(name)).content;
      },
    },
    {
      name: "loadSkillResource",
      description: "Load a resource inside a bundled skill directory.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" }, relativePath: { type: "string" } },
        required: ["name", "relativePath"],
        additionalProperties: false,
      },
      async invoke({ input }) {
        const name = getString(input, "name");
        const relativePath = getString(input, "relativePath");
        rejectParentPath(relativePath);
        return options.catalog.loadResource(name, relativePath);
      },
    },
    {
      name: "runBundledScript",
      description: "Run a manifest-whitelisted bundled Superpowers script.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" }, args: { type: "array", items: { type: "string" } } },
        required: ["name", "args"],
        additionalProperties: false,
      },
      async invoke({ input, signal }) {
        const name = getString(input, "name");
        const args = getStrings(input, "args");
        const script = scripts[name];
        if (!script) throw new Error(`Bundled script is not allowed: ${name}`);
        rejectParentPath(script);
        const scriptPath = resolveInside(options.resourceRoot, script);
        const bashPath = await (options.findGitBash ?? findGitBash)();
        if (!bashPath) throw new Error("Git Bash is required to run bundled scripts; install Git for Windows or configure bash.exe");
        return (options.execute ?? executeWithGitBash)(bashPath, scriptPath, args, signal);
      },
    },
    {
      name: "reportSubagentResult",
      description: "Submit the structured outcome of the current subagent task. Required: status, summary, reportPath, commit, tests; optional concerns.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["status", "summary", "reportPath", "commit", "tests"],
        properties: {
          status: { type: "string", enum: ["DONE", "DONE_WITH_CONCERNS", "NEEDS_CONTEXT", "BLOCKED"] },
          summary: { type: "string" },
          reportPath: { type: "string" },
          commit: { type: "string" },
          tests: { type: "array", items: { type: "string" } },
          concerns: { type: "array", items: { type: "string" } },
        },
      },
      resultSchema: { status: ["DONE", "DONE_WITH_CONCERNS", "NEEDS_CONTEXT", "BLOCKED"] },
      async invoke({ input }) {
        const result = parseSubagentResult(input);
        if (!result) return rejectInvalidReport("reportSubagentResult");
        options.onSubagentResult?.(result);
        return "Subagent result recorded";
      },
    },
    {
      name: "reportReview",
      description: "Submit structured specification and quality review conclusions. Required: specCompliant, qualityApproved, findings.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["specCompliant", "qualityApproved", "findings"],
        properties: {
          specCompliant: { type: "boolean" },
          qualityApproved: { type: "boolean" },
          findings: { type: "array", items: { type: "string" } },
        },
      },
      resultSchema: { required: ["specCompliant", "qualityApproved", "findings"] },
      async invoke({ input }) {
        const result = parseReviewResult(input);
        if (!result) return rejectInvalidReport("reportReview");
        options.onReview?.(result);
        return "Review result recorded";
      },
    },
  ];
}

function readBundledScripts(resourceRoot: string): Record<string, string> {
  try {
    const manifest = JSON.parse(readFileSync(resolve(resourceRoot, "manifest.json"), "utf8")) as BundledScriptsManifest;
    return manifest.scripts && isRecord(manifest.scripts) ? manifest.scripts : {};
  } catch {
    return {};
  }
}

function rejectParentPath(value: string): void {
  if (isAbsolute(value) || value.split(/[\\/]+/).includes("..")) throw new Error(`Parent paths are not allowed: ${value}`);
}

function resolveInside(root: string, requestedPath: string): string {
  const resolvedRoot = realpathSync(root);
  const candidate = realpathSync(resolve(resolvedRoot, requestedPath));
  const pathFromRoot = relative(resolvedRoot, candidate);
  if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) throw new Error(`Path is outside the allowed directory: ${requestedPath}`);
  return candidate;
}

async function findGitBash(): Promise<string | undefined> {
  const candidates = [
    process.env.ProgramFiles ? resolve(process.env.ProgramFiles, "Git", "bin", "bash.exe") : "",
    process.env["ProgramFiles(x86)"] ? resolve(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe") : "",
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

function executeWithGitBash(bashPath: string, scriptPath: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(bashPath, [scriptPath, ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const abort = () => child.kill();
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) return reject(signal.reason);
      if (code !== 0) return reject(new Error(output.trim() || `Bundled script exited with code ${code}`));
      resolveResult(output);
    });
    signal.addEventListener("abort", abort, { once: true });
  });
}

function getString(input: unknown, field: string): string {
  if (!isRecord(input) || typeof input[field] !== "string" || input[field].trim().length === 0) throw new Error(`Invalid ${field}`);
  return input[field];
}

function getStrings(input: unknown, field: string): string[] {
  if (!isRecord(input) || !Array.isArray(input[field]) || !input[field].every((value) => typeof value === "string")) throw new Error(`Invalid ${field}`);
  return input[field];
}

function parseSubagentResult(input: unknown): SubagentResult | undefined {
  if (!isRecord(input)) return undefined;
  const allowed = new Set<SubagentStatus>(["DONE", "DONE_WITH_CONCERNS", "NEEDS_CONTEXT", "BLOCKED"]);
  if (!allowed.has(input.status as SubagentStatus) || !hasStrings(input, "summary", "reportPath", "commit") || !hasStringArray(input, "tests")) return undefined;
  if (input.concerns !== undefined && !hasStringArray(input, "concerns")) return undefined;
  return input as SubagentResult;
}

function parseReviewResult(input: unknown): ReviewResult | undefined {
  if (!isRecord(input) || typeof input.specCompliant !== "boolean" || typeof input.qualityApproved !== "boolean" || !hasStringArray(input, "findings")) return undefined;
  return input as ReviewResult;
}

function hasStrings(input: Record<string, unknown>, ...fields: string[]): boolean {
  return fields.every((field) => typeof input[field] === "string" && input[field].trim().length > 0);
}

function hasStringArray(input: Record<string, unknown>, field: string): boolean {
  return Array.isArray(input[field]) && input[field].every((value) => typeof value === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
