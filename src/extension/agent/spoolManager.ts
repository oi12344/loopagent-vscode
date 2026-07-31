import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Spool 文件管理器
 * 管理工具输出的临时缓冲文件，按 conversationId 隔离
 */
export type SpoolManager = {
  /**
   * 写入 spool 文件
   * @param filename - 文件名（不含路径）
   * @param content - 文件内容
   * @returns 相对于工作区根目录的路径
   */
  writeSpoolFile(filename: string, content: string): Promise<string>;

  /**
   * 获取 spool 目录路径
   */
  getSpoolDirectory(): string;
};

export type CreateSpoolManagerOptions = {
  workspaceRoot: string;
  conversationId: string;
};

export function createSpoolManager({ workspaceRoot, conversationId }: CreateSpoolManagerOptions): SpoolManager {
  const spoolDirectory = join(workspaceRoot, ".loopagent", "runs", conversationId);

  return {
    async writeSpoolFile(filename, content) {
      await mkdir(spoolDirectory, { recursive: true });
      const fullPath = join(spoolDirectory, filename);
      await writeFile(fullPath, content, "utf-8");

      // 返回相对路径（从工作区根目录开始）
      return join(".loopagent", "runs", conversationId, filename);
    },

    getSpoolDirectory() {
      return spoolDirectory;
    },
  };
}
