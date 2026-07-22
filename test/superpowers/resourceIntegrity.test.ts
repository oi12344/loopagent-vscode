import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const resourcesPath = (...paths: string[]) =>
  resolve(process.cwd(), "resources", "superpowers", ...paths);

type Manifest = {
  version: string;
  skills: Array<{ name: string; description: string; path: string }>;
};

function readManifest(): Manifest {
  return JSON.parse(readFileSync(resourcesPath("manifest.json"), "utf8")) as Manifest;
}

describe("vendored Superpowers resources", () => {
  it("pins the complete official v6.1.1 skill catalog", () => {
    const manifest = readManifest();

    expect(manifest.version).toBe("6.1.1");
    expect(manifest.skills).toHaveLength(14);
    expect(manifest.skills.map((skill) => skill.name)).toContain(
      "subagent-driven-development",
    );
    expect(existsSync(resourcesPath("LICENSE"))).toBe(true);

    for (const skill of manifest.skills) {
      expect(skill.description).not.toBe("");
      expect(skill.path).toMatch(/^skills\/[^/]+\/SKILL\.md$/);
      expect(existsSync(resourcesPath(skill.path))).toBe(true);
    }
  });
});
