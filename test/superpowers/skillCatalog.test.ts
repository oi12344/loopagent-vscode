import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSkillCatalog } from "../../src/extension/superpowers/skillCatalog";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SkillCatalog", () => {
  it("loads the vendored brainstorming skill", async () => {
    const catalog = await createSkillCatalog(
      resolve(process.cwd(), "resources", "superpowers"),
    );

    const skill = await catalog.load("brainstorming");

    expect(catalog.list()).toContainEqual({
      name: "brainstorming",
      description: expect.any(String),
      skillPath: "skills/brainstorming/SKILL.md",
    });
    expect(skill.content).toContain("Brainstorming Ideas Into Designs");
  });

  it("rejects a resource path outside its skill directory", async () => {
    const catalog = await createSkillCatalog(
      resolve(process.cwd(), "resources", "superpowers"),
    );

    await expect(catalog.loadResource("brainstorming", "../LICENSE")).rejects.toThrow(/parent/i);
  });

  it("rejects a resource path containing an in-root parent segment", async () => {
    const catalog = await createSkillCatalog(
      resolve(process.cwd(), "resources", "superpowers"),
    );

    await expect(
      catalog.loadResource("brainstorming", "scripts/../visual-companion.md"),
    ).rejects.toThrow(/parent/i);
  });

  it("rejects an absolute resource path", async () => {
    const catalog = await createSkillCatalog(
      resolve(process.cwd(), "resources", "superpowers"),
    );

    await expect(
      catalog.loadResource("brainstorming", resolve(process.cwd(), "resources", "superpowers", "LICENSE")),
    ).rejects.toThrow(/absolute/i);
  });

  it("rejects a symbolic link that escapes its skill directory", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "loopagent-skill-catalog-"));
    temporaryDirectories.push(temporaryDirectory);
    const resourceRoot = join(temporaryDirectory, "resources");
    const skillDirectory = join(resourceRoot, "skills", "brainstorming");
    const skillPath = join(skillDirectory, "SKILL.md");
    const outsidePath = join(temporaryDirectory, "secret.md");

    await mkdir(skillDirectory, { recursive: true });
    await writeFile(skillPath, "# Brainstorming", "utf8");
    await writeFile(outsidePath, "secret", "utf8");
    await writeFile(
      join(resourceRoot, "manifest.json"),
      JSON.stringify({
        version: "6.1.1",
        skills: [{ name: "brainstorming", description: "test", path: "skills/brainstorming/SKILL.md" }],
      }),
      "utf8",
    );
    await symlink(outsidePath, join(dirname(skillPath), "escape.md"), "file");

    const catalog = await createSkillCatalog(resourceRoot);

    await expect(catalog.loadResource("brainstorming", "escape.md")).rejects.toThrow(/outside/i);
  });
});
