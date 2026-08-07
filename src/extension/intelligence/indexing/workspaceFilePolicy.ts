export function normalizePathSeparators(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

export function isIndexableWorkspacePath(filePath: string): boolean {
  const normalized = normalizePathSeparators(filePath).toLowerCase();
  const parts = normalized.split("/").filter(Boolean);
  const fileName = parts.at(-1) ?? "";
  const sensitiveName = /(^|[._-])(secret|secrets|token|tokens|api[_-]?key|apikey|key)([._-]|$)/i;

  if (
    parts.some(
      (part) => part === ".git" || part === "node_modules" || part === "dist" || part.startsWith(".local-vscode-"),
    )
  ) {
    return false;
  }
  if (fileName === ".env" || fileName.startsWith(".env.")) {
    return false;
  }
  return !parts.some((part) => sensitiveName.test(part));
}

export function detectWorkspaceLanguageId(filePath: string): string | undefined {
  const normalized = normalizePathSeparators(filePath).toLowerCase();
  if (normalized.endsWith(".tsx")) return "typescriptreact";
  if (normalized.endsWith(".ts")) return "typescript";
  if (normalized.endsWith(".jsx")) return "javascriptreact";
  if (normalized.endsWith(".js")) return "javascript";
  if (normalized.endsWith(".py")) return "python";
  if (normalized.endsWith(".java")) return "java";
  return undefined;
}
