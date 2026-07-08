export function isIndexableWorkspacePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const parts = normalized.split("/").filter(Boolean);
  const fileName = parts.at(-1) ?? "";

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

  return !/(^|[._-])(secret|secrets|token|tokens|api[_-]?key|apikey|key)([._-]|$)/i.test(fileName);
}
