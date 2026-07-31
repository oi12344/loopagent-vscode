import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, "test/mocks/vscode.ts"),
    },
  },
  test: {
    environment: "node",
    // .local-vscode-extensions 是本地安装的打包产物，其中含随扩展一起打包的测试文件；
    // 与 dist 同属构建输出，不能当源码测试跑（依赖未随包安装，加载即失败）。
    exclude: [...configDefaults.exclude, ".worktrees/**", ".claude/worktrees/**", "test/integration/**", "dist/**", ".local-vscode-extensions/**"],
  },
});
