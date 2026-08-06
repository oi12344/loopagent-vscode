import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import { createWorktreeManager } from "../../src/extension/agent/workflow/worktreeManager";

describe("worktreeManager", () => {
  let testRepoPath: string;
  let manager: ReturnType<typeof createWorktreeManager>;

  beforeEach(() => {
    // 创建临时 git 仓库用于测试
    testRepoPath = mkdtempSync(join(tmpdir(), "loopagent-worktree-test-"));

    // 初始化 git 仓库
    execSync("git init", { cwd: testRepoPath });
    execSync('git config user.email "test@example.com"', { cwd: testRepoPath });
    execSync('git config user.name "Test User"', { cwd: testRepoPath });

    // 创建初始提交
    writeFileSync(join(testRepoPath, "README.md"), "# Test Repository");
    execSync("git add .", { cwd: testRepoPath });
    execSync('git commit -m "Initial commit"', { cwd: testRepoPath });

    manager = createWorktreeManager(testRepoPath);
  });

  afterEach(() => {
    // 清理测试仓库
    if (existsSync(testRepoPath)) {
      rmSync(testRepoPath, { recursive: true, force: true });
    }
  });

  describe("isGitRepo", () => {
    it("returns true for a git repository", async () => {
      const result = await manager.isGitRepo();
      expect(result).toBe(true);
    });

    it("returns false for a non-git directory", async () => {
      const nonGitPath = mkdtempSync(join(tmpdir(), "non-git-"));
      const nonGitManager = createWorktreeManager(nonGitPath);

      const result = await nonGitManager.isGitRepo();
      expect(result).toBe(false);

      rmSync(nonGitPath, { recursive: true, force: true });
    });
  });

  describe("createWorktree", () => {
    it("creates a worktree with a unique branch", async () => {
      const worktree = await manager.createWorktree("subagent-1", "Fix login bug");

      expect(worktree.subagentId).toBe("subagent-1");
      expect(worktree.branch).toMatch(/^worktree\/fix-login-bug-\d+$/);
      expect(existsSync(worktree.path)).toBe(true);

      // 验证 worktree 中有初始文件
      expect(existsSync(join(worktree.path, "README.md"))).toBe(true);
    });

    it("creates multiple worktrees with different branches", async () => {
      const worktree1 = await manager.createWorktree("subagent-1", "Task 1");
      const worktree2 = await manager.createWorktree("subagent-2", "Task 2");

      expect(worktree1.branch).not.toBe(worktree2.branch);
      expect(worktree1.path).not.toBe(worktree2.path);
      expect(existsSync(worktree1.path)).toBe(true);
      expect(existsSync(worktree2.path)).toBe(true);
    });

    it("sanitizes task names in branch names", async () => {
      const worktree = await manager.createWorktree("subagent-1", "Add User Authentication & Authorization!");

      expect(worktree.branch).toMatch(/^worktree\/add-user-authentication-author-\d+$/);
    });

    it("truncates long task names", async () => {
      const longTask = "This is a very long task description that should be truncated to fit within the branch name limits";
      const worktree = await manager.createWorktree("subagent-1", longTask);

      // Branch name should be truncated to 30 chars (plus prefix and timestamp)
      const branchParts = worktree.branch.split("-");
      const taskPart = branchParts.slice(1, -1).join("-"); // Remove "worktree/" prefix and timestamp
      expect(taskPart.length).toBeLessThanOrEqual(30);
    });
  });

  describe("cleanupWorktree", () => {
    it("removes worktree without keeping changes", async () => {
      const worktree = await manager.createWorktree("subagent-1", "Test task");

      expect(existsSync(worktree.path)).toBe(true);

      await manager.cleanupWorktree(worktree, false);

      expect(existsSync(worktree.path)).toBe(false);
    });

    it("commits and merges changes when keeping them", async () => {
      const worktree = await manager.createWorktree("subagent-1", "Test task");

      // 在 worktree 中创建新文件
      writeFileSync(join(worktree.path, "newfile.txt"), "New content");

      await manager.cleanupWorktree(worktree, true);

      // Worktree 应该被删除
      expect(existsSync(worktree.path)).toBe(false);

      // 新文件应该被合并到主仓库
      expect(existsSync(join(testRepoPath, "newfile.txt"))).toBe(true);
    });

    it("handles worktree with no changes", async () => {
      const worktree = await manager.createWorktree("subagent-1", "Test task");

      // 不做任何修改
      await manager.cleanupWorktree(worktree, true);

      expect(existsSync(worktree.path)).toBe(false);
    });

    it("handles already deleted worktree gracefully", async () => {
      const worktree = await manager.createWorktree("subagent-1", "Test task");

      // 手动删除 worktree 目录
      rmSync(worktree.path, { recursive: true, force: true });

      // 应该不会抛出错误
      await expect(manager.cleanupWorktree(worktree, false)).resolves.not.toThrow();
    });
  });

  describe("integration scenarios", () => {
    it("simulates executor workflow with worktree isolation", async () => {
      // 创建两个并行的 executor worktrees
      const worktree1 = await manager.createWorktree("executor-1", "Fix auth");
      const worktree2 = await manager.createWorktree("executor-2", "Add logging");

      // 每个 worktree 独立修改文件
      writeFileSync(join(worktree1.path, "auth.ts"), "// Auth fix");
      writeFileSync(join(worktree2.path, "logger.ts"), "// Logger added");

      // 清理第一个 worktree（保留更改）
      await manager.cleanupWorktree(worktree1, true);
      expect(existsSync(join(testRepoPath, "auth.ts"))).toBe(true);

      // 清理第二个 worktree（不保留更改）
      await manager.cleanupWorktree(worktree2, false);
      expect(existsSync(join(testRepoPath, "logger.ts"))).toBe(false);
    });

    it("handles failed executor with proper cleanup", async () => {
      const worktree = await manager.createWorktree("executor-1", "Broken change");

      // 模拟失败的更改
      writeFileSync(join(worktree.path, "broken.ts"), "// This breaks everything");

      // 失败时不保留更改
      await manager.cleanupWorktree(worktree, false);

      expect(existsSync(worktree.path)).toBe(false);
      expect(existsSync(join(testRepoPath, "broken.ts"))).toBe(false);
    });
  });
});
