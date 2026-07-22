import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type { LoadedSkill, SkillCatalog, SuperpowersSkill } from "./superpowersTypes";

type Manifest = {
  skills: Array<{ name: string; description: string; path: string }>;
};

export async function createSkillCatalog(resourceRoot: string): Promise<SkillCatalog> {
  const resolvedRoot = await realpath(resourceRoot);
  const manifestPath = await resolveInside(resolvedRoot, "manifest.json");
  const manifest = parseManifest(await readFile(manifestPath, "utf8"));
  const skills = manifest.skills.map(({ name, description, path: skillPath }) => ({
    name,
    description,
    skillPath,
  }));
  const skillsByName = new Map(skills.map((skill) => [skill.name, skill]));

  return {
    list: () => skills,
    async load(name) {
      const skill = getSkill(skillsByName, name);
      const skillPath = await resolveInside(resolvedRoot, skill.skillPath);
      return { ...skill, content: await readFile(skillPath, "utf8") };
    },
    async loadResource(name, relativePath) {
      const skill = getSkill(skillsByName, name);
      const skillPath = await resolveInside(resolvedRoot, skill.skillPath);
      const resourcePath = await resolveInside(dirname(skillPath), relativePath);
      return readFile(resourcePath, "utf8");
    },
  };
}

function parseManifest(value: string): Manifest {
  const manifest: unknown = JSON.parse(value);
  if (!isManifest(manifest)) throw new Error("Invalid Superpowers manifest");
  return manifest;
}

function isManifest(value: unknown): value is Manifest {
  if (!value || typeof value !== "object" || !Array.isArray((value as Manifest).skills)) return false;
  return (value as Manifest).skills.every(
    (skill) =>
      skill &&
      typeof skill.name === "string" &&
      typeof skill.description === "string" &&
      typeof skill.path === "string",
  );
}

function getSkill(skillsByName: ReadonlyMap<string, SuperpowersSkill>, name: string): SuperpowersSkill {
  const skill = skillsByName.get(name);
  if (!skill) throw new Error(`Unknown Superpowers skill: ${name}`);
  return skill;
}

async function resolveInside(root: string, requestedPath: string): Promise<string> {
  if (isAbsolute(requestedPath)) throw new Error(`Absolute paths are not allowed: ${requestedPath}`);
  if (requestedPath.split(/[\\/]+/).includes("..")) {
    throw new Error(`Parent path segments are not allowed: ${requestedPath}`);
  }

  const candidate = resolve(root, requestedPath);
  if (!isInside(root, candidate)) throw new Error(`Path is outside the allowed directory: ${requestedPath}`);

  const resolvedCandidate = await realpath(candidate);
  if (!isInside(root, resolvedCandidate)) {
    throw new Error(`Resolved path is outside the allowed directory: ${requestedPath}`);
  }
  return resolvedCandidate;
}

function isInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}
