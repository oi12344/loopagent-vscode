import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

  it("rejects a destination outside the vendored resource directory before replacing it", () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "loopagent-superpowers-destination-"));
    const unsafeDestination = temporaryDirectory;
    const sentinelPath = join(unsafeDestination, "keep.txt");
    mkdirSync(unsafeDestination, { recursive: true });
    writeFileSync(sentinelPath, "keep");

    try {
      const result = spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          resolve(process.cwd(), "scripts", "vendor-superpowers.ps1"),
          "-Tag",
          "v6.1.1",
          "-Destination",
          ".",
        ],
        { cwd: temporaryDirectory, encoding: "utf8" },
      );

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "Destination must be resources/superpowers",
      );
      expect(readFileSync(sentinelPath, "utf8")).toBe("keep");
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }, 15_000);
});
