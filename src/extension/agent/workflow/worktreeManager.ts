import { exec } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";

const execAsync = promisify(exec);

/**
 * Git Worktree 管理器
 * 为 executor 子代理创建隔离的工作区，避免并行修改冲突
 */

export type WorktreeInfo = {
  /** Worktree 的绝对路径 */
  path: string;
  /** 创建的分支名 */
  branch: string;
  /** 子代理 ID */
  subagentId: string;
};

export type WorktreeManager = {
  /** 为子代理创建独立的 worktree */
  createWorktree(subagentId: string, task: string): Promise<WorktreeInfo>;
  /** 清理 worktree（可选择是否保留更改） */
  cleanupWorktree(info: WorktreeInfo, keepChanges: boolean): Promise<void>;
  /** 检查是否在 git 仓库中 */
  isGitRepo(): Promise<boolean>;
};

/**
 * 创建 worktree 管理器
 */
export function createWorktreeManager(repoPath: string): WorktreeManager {
  const worktreeBaseDir = join(repoPath, ".claude", "worktrees");

  async function isGitRepo(): Promise<boolean> {
    try {
      await execAsync("git rev-parse --git-dir", { cwd: repoPath });
      return true;
    } catch {
      return false;
    }
  }

  async function getCurrentBranch(): Promise<string> {
    const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", { cwd: repoPath });
    return stdout.trim();
  }

  async function createWorktree(subagentId: string, task: string): Promise<WorktreeInfo> {
    // 生成唯一的分支名
    const timestamp = Date.now();
    const sanitizedTask = task
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 30);
    const branch = `worktree/${sanitizedTask}-${timestamp}`;

    // Worktree 路径
    const worktreePath = join(worktreeBaseDir, `${subagentId}-${timestamp}`);

    // 获取当前分支作为基础
    const baseBranch = await getCurrentBranch();

    try {
      // 创建 worktree 和新分支
      await execAsync(`git worktree add -b "${branch}" "${worktreePath}" "${baseBranch}"`, {
        cwd: repoPath,
      });

      return {
        path: worktreePath,
        branch,
        subagentId,
      };
    } catch (error) {
      throw new Error(`Failed to create worktree: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function cleanupWorktree(info: WorktreeInfo, keepChanges: boolean): Promise<void> {
    try {
      // 检查 worktree 是否仍然存在
      if (!existsSync(info.path)) {
        // 如果目录不存在，仍然尝试删除 git 记录
        try {
          await execAsync(`git worktree remove "${info.path}" --force`, { cwd: repoPath });
        } catch {
          // 忽略错误，可能已经被删除
        }
        return;
      }

      if (keepChanges) {
        // 检查是否有未提交的更改
        const { stdout: statusOutput } = await execAsync("git status --porcelain", { cwd: info.path });

        if (statusOutput.trim()) {
          // 有未提交的更改，先提交
          await execAsync('git add -A', { cwd: info.path });
          await execAsync(`git commit -m "Auto-commit from subagent ${info.subagentId}"`, { cwd: info.path });
        }

        // 切换回主仓库
        const baseBranch = await getCurrentBranch();

        // 合并更改到当前分支
        await execAsync(`git merge --no-ff "${info.branch}" -m "Merge worktree changes from ${info.subagentId}"`, {
          cwd: repoPath,
        });

        // 删除 worktree 和分支
        await execAsync(`git worktree remove "${info.path}"`, { cwd: repoPath });
        await execAsync(`git branch -d "${info.branch}"`, { cwd: repoPath });
      } else {
        // 不保留更改，强制删除
        await execAsync(`git worktree remove "${info.path}" --force`, { cwd: repoPath });
        await execAsync(`git branch -D "${info.branch}"`, { cwd: repoPath }).catch(() => {
          // 忽略分支删除失败（可能不存在）
        });
      }
    } catch (error) {
      throw new Error(`Failed to cleanup worktree: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    createWorktree,
    cleanupWorktree,
    isGitRepo,
  };
}
