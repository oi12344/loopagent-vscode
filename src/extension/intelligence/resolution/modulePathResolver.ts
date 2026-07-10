import path from "node:path";

import type { ImportBinding } from "../graph/graphTypes";

const TYPESCRIPT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
const TYPESCRIPT_LANGUAGE_IDS = new Set(["typescript", "typescriptreact", "javascript", "javascriptreact"]);

export function resolveImportBindings(
  bindings: readonly ImportBinding[],
  workspaceFilePaths: readonly string[],
): ImportBinding[] {
  const originalPathByNormalizedPath = new Map(
    workspaceFilePaths.map((filePath) => [normalizePath(filePath), filePath] as const),
  );

  return bindings.map((binding) => {
    const resolvedFilePath =
      binding.resolvedFilePath ?? resolveBindingPath(binding, originalPathByNormalizedPath);
    return resolvedFilePath ? { ...binding, resolvedFilePath } : { ...binding };
  });
}

function resolveBindingPath(
  binding: ImportBinding,
  originalPathByNormalizedPath: ReadonlyMap<string, string>,
): string | undefined {
  if (TYPESCRIPT_LANGUAGE_IDS.has(binding.languageId)) {
    return resolveTypeScriptPath(binding, originalPathByNormalizedPath);
  }
  if (binding.languageId === "python") {
    return resolvePythonPath(binding, originalPathByNormalizedPath);
  }
  return undefined;
}

function resolveTypeScriptPath(
  binding: ImportBinding,
  originalPathByNormalizedPath: ReadonlyMap<string, string>,
): string | undefined {
  if (!binding.source.startsWith(".")) {
    return undefined;
  }

  const importerDirectory = path.posix.dirname(normalizePath(binding.filePath));
  const basePath = path.posix.normalize(path.posix.join(importerDirectory, binding.source));
  const candidates = path.posix.extname(basePath)
    ? [basePath]
    : [
        basePath,
        ...TYPESCRIPT_EXTENSIONS.map((extension) => `${basePath}${extension}`),
        ...TYPESCRIPT_EXTENSIONS.map((extension) => `${basePath}/index${extension}`),
      ];
  return findWorkspacePath(candidates, originalPathByNormalizedPath);
}

function resolvePythonPath(
  binding: ImportBinding,
  originalPathByNormalizedPath: ReadonlyMap<string, string>,
): string | undefined {
  const importerDirectory = path.posix.dirname(normalizePath(binding.filePath));
  const relativeMatch = /^(\.+)(.*)$/.exec(binding.source);
  let basePath: string;

  if (relativeMatch) {
    basePath = importerDirectory;
    for (let level = 1; level < relativeMatch[1]!.length; level += 1) {
      basePath = path.posix.dirname(basePath);
    }
    const modulePath = relativeMatch[2]!.replace(/\./g, "/");
    if (modulePath) {
      basePath = path.posix.join(basePath, modulePath);
    }
  } else {
    basePath = binding.source.replace(/\./g, "/");
  }

  const candidates = [`${basePath}.py`, `${basePath}/__init__.py`];
  return findWorkspacePath(candidates, originalPathByNormalizedPath);
}

function findWorkspacePath(
  candidates: readonly string[],
  originalPathByNormalizedPath: ReadonlyMap<string, string>,
): string | undefined {
  for (const candidate of candidates) {
    const existing = originalPathByNormalizedPath.get(normalizePath(candidate));
    if (existing) {
      return existing;
    }
  }
  return undefined;
}

function normalizePath(filePath: string): string {
  return path.posix.normalize(filePath.replace(/\\/g, "/"));
}
