import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSkillCatalog } from "../../src/extension/superpowers/skillCatalog";
import { createSuperpowersTools } from "../../src/extension/superpowers/superpowersTools";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createCatalog(scripts: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "loopagent-superpowers-tools-"));
  directories.push(root);
  await mkdir(join(root, "skills", "sample"), { recursive: true });
  await writeFile(join(root, "skills", "sample", "SKILL.md"), "# Sample", "utf8");
  await writeFile(join(root, "skills", "sample", "reference.md"), "reference", "utf8");
  for (const script of Object.values(scripts)) {
    const scriptPath = join(root, script);
    await mkdir(join(scriptPath, ".."), { recursive: true });
    await writeFile(scriptPath, "#!/usr/bin/env bash\n", "utf8");
  }
  await writeFile(join(root, "manifest.json"), JSON.stringify({ skills: [{ name: "sample", description: "sample", path: "skills/sample/SKILL.md" }], scripts }), "utf8");
  return { catalog: await createSkillCatalog(root), root };
}

describe("Superpowers tools", () => {
  it("loads a requested skill and rejects resources outside its skill directory", async () => {
    const { catalog, root } = await createCatalog();
    const tools = createSuperpowersTools({ catalog, resourceRoot: root });

    await expect(invoke(tools, "loadSkill", { name: "sample" })).resolves.toContain("# Sample");
    await expect(invoke(tools, "loadSkillResource", { name: "sample", relativePath: "../manifest.json" })).rejects.toThrow(/parent/i);
  });

  it("rejects scripts outside the manifest whitelist", async () => {
    const { catalog, root } = await createCatalog();
    const tools = createSuperpowersTools({ catalog, resourceRoot: root });

    await expect(invoke(tools, "runBundledScript", { name: "not-listed", args: [] })).rejects.toThrow(/not allowed/i);
  });

  it("reports a diagnostic when Git Bash is unavailable", async () => {
    const { catalog, root } = await createCatalog({ "check.sh": "scripts/check.sh" });
    const tools = createSuperpowersTools({
      catalog,
      resourceRoot: root,
      findGitBash: async () => undefined,
    });

    await expect(invoke(tools, "runBundledScript", { name: "check.sh", args: [] })).rejects.toThrow(/Git Bash is required/i);
  });

  it("allows one report correction before blocking invalid result data", async () => {
    const { catalog, root } = await createCatalog();
    const tools = createSuperpowersTools({ catalog, resourceRoot: root });

    await expect(invoke(tools, "reportSubagentResult", { status: "invalid" })).rejects.toThrow(/correct/i);
    await expect(invoke(tools, "reportSubagentResult", { status: "invalid" })).rejects.toThrow(/blocked/i);
  });

  it("requires both review conclusions and findings", async () => {
    const { catalog, root } = await createCatalog();
    const tools = createSuperpowersTools({ catalog, resourceRoot: root });

    await expect(invoke(tools, "reportReview", { specCompliant: true, findings: [] })).rejects.toThrow(/correct/i);
  });

  it("exposes the required structured fields to the model", async () => {
    const { catalog, root } = await createCatalog();
    const tools = createSuperpowersTools({ catalog, resourceRoot: root });
    const report = tools.find((tool) => tool.name === "reportSubagentResult");
    const review = tools.find((tool) => tool.name === "reportReview");

    expect(report?.inputSchema).toMatchObject({
      type: "object",
      required: ["status", "summary", "reportPath", "commit", "tests"],
      properties: {
        status: { type: "string", enum: ["DONE", "DONE_WITH_CONCERNS", "NEEDS_CONTEXT", "BLOCKED"] },
        tests: { type: "array", items: { type: "string" } },
      },
    });
    expect(review?.inputSchema).toMatchObject({
      type: "object",
      required: ["specCompliant", "qualityApproved", "findings"],
      properties: {
        specCompliant: { type: "boolean" },
        qualityApproved: { type: "boolean" },
        findings: { type: "array", items: { type: "string" } },
      },
    });
  });
});

function invoke(tools: ReturnType<typeof createSuperpowersTools>, name: string, input: unknown): Promise<string> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return Promise.resolve(tool.invoke({ request: { id: "tool-1", name, rawArguments: JSON.stringify(input), input }, input, signal: new AbortController().signal }));
}
