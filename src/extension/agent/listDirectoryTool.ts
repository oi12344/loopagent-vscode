import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep, isAbsolute } from "node:path";
import type * as vscode from "vscode";
import type { ReactAgentTool } from "./reactTypes";

const MAX_ENTRIES = 500;

export function createListDirectoryTool(
  vscodeApi: Pick<typeof vscode, "workspace">
): ReactAgentTool {
  return {
    name: "listDirectory",
    description: `列出指定目录下的文件和子目录。

**用途**：
- 探索项目结构（模块、配置、资源）
- 查找特定文件或目录
- 验证路径是否存在

**返回格式**：
每行一个条目，格式为 \`[类型] 名称\`
- \`[D]\` = 目录
- \`[F]\` = 文件

**优先使用场景**：
当需要了解目录结构时，优先使用此工具，而非 \`runCommand("dir")\` 或 \`runCommand("ls")\`。`,
    isConcurrencySafe: () => true,
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description: "相对于工作区根目录的路径（如 '.' 或 'src/extension'）。不支持绝对路径。"
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async invoke({ input, signal }) {
      const inputPath = parseInput(input);
      signal.throwIfAborted();

      const resolvedPath = await resolveWorkspacePath(vscodeApi, inputPath);
      signal.throwIfAborted();

      const entries = await listDirectoryEntries(resolvedPath, signal);
      signal.throwIfAborted();

      if (entries.length === 0) {
        return `Directory is empty: ${inputPath}`;
      }

      if (entries.length > MAX_ENTRIES) {
        const truncated = entries.slice(0, MAX_ENTRIES);
        const output = formatEntries(truncated);
        return `${output}\n\n(Output truncated: showing ${MAX_ENTRIES} of ${entries.length} entries)`;
      }

      return formatEntries(entries);
    },
  };
}

function parseInput(input: unknown): string {
  if (!isRecord(input) || typeof input.path !== "string" || input.path.trim().length === 0) {
    throw new Error("Invalid listDirectory input");
  }
  const keys = Object.keys(input);
  if (!keys.every((key) => key === "path")) {
    throw new Error("Invalid listDirectory input");
  }
  return input.path;
}

async function resolveWorkspacePath(
  vscodeApi: Pick<typeof vscode, "workspace">,
  requestedPath: string,
): Promise<string> {
  const workspaceRoot = vscodeApi.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    throw new Error("listDirectory requires an open workspace folder");
  }

  if (isAbsolute(requestedPath)) {
    throw new Error("Invalid listDirectory path: absolute paths are not supported");
  }

  try {
    const resolved = resolve(workspaceRoot, requestedPath);
    const relation = relative(workspaceRoot, resolved);

    // 防止路径逃逸
    if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
      throw new Error("Invalid listDirectory path: cannot escape workspace");
    }

    const stats = await stat(resolved);
    if (!stats.isDirectory()) {
      throw new Error("Invalid listDirectory path: not a directory");
    }

    return resolved;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid listDirectory path")) {
      throw error;
    }
    throw new Error("Invalid listDirectory path", { cause: error });
  }
}

type DirectoryEntry = {
  name: string;
  type: "file" | "directory";
};

async function listDirectoryEntries(
  dirPath: string,
  signal: AbortSignal,
): Promise<DirectoryEntry[]> {
  signal.throwIfAborted();

  const entries: DirectoryEntry[] = [];
  const names = await readdir(dirPath);

  signal.throwIfAborted();

  for (const name of names) {
    signal.throwIfAborted();

    try {
      const fullPath = join(dirPath, name);
      const stats = await stat(fullPath);
      entries.push({
        name,
        type: stats.isDirectory() ? "directory" : "file",
      });
    } catch (error) {
      // 跳过无法访问的条目（权限问题、符号链接损坏等）
      console.warn(`[listDirectory] Skipping inaccessible entry: ${name}`, error);
    }
  }

  // 排序：目录优先，然后按名称
  entries.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "directory" ? -1 : 1;
    }
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });

  return entries;
}

function formatEntries(entries: DirectoryEntry[]): string {
  const lines = entries.map((entry) => {
    const typeMarker = entry.type === "directory" ? "[D]" : "[F]";
    return `${typeMarker} ${entry.name}`;
  });
  return lines.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
