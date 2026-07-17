# 右侧副侧边栏实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 将 LoopAgent Chat 默认注册到 VS Code 右侧副侧边栏。

**架构：** 仅修改 VS Code manifest 的视图容器贡献点。现有容器 ID、视图 ID 和 `loopagent.focusChat` 命令不变，因此 Webview provider 不需要代码迁移。

**技术栈：** VS Code extension manifest、TypeScript、Vitest、现有 VSIX 打包脚本。

## 全局约束

- 容器 ID 保持 `loopagent`，视图 ID 保持 `loopagent.chat`。
- 使用 `contributes.viewsContainers.secondarySidebar`，不再声明 `activitybar` 容器。
- 不修改模型推理、Webview UI 或命令实现。
- 文档使用中文；不新增依赖；在当前 `main` checkout 工作。

---

### Task 1: 将 LoopAgent 注册到右侧副侧边栏

**文件：**
- 修改：`test/packageManifest.test.ts:22-44`
- 修改：`package.json:39-47`
- 修改：`docs/superpowers/plans/2026-07-17-right-secondary-sidebar-plan.md`

**接口：**
- 消费：现有 manifest 的 `contributes.viewsContainers`。
- 产出：`loopagent` 容器在 `secondarySidebar` 注册，`loopagent.chat` 视图和 `loopagent.focusChat` 命令保持不变。

- [x] **步骤 1：写入失败的 manifest 契约测试**

将 `test/packageManifest.test.ts` 中的断言替换为：

```ts
expect(manifest.contributes.viewsContainers.secondarySidebar).toContainEqual({
  id: "loopagent",
  title: "LoopAgent",
  icon: "resources/loopagent.svg",
});
expect(manifest.contributes.viewsContainers.activitybar).toBeUndefined();
```

- [x] **步骤 2：运行测试并确认失败**

运行：`npx vitest run test/packageManifest.test.ts`

预期：失败，因为当前 manifest 只在 `activitybar` 声明 `loopagent`。

- [x] **步骤 3：实施最小 manifest 变更**

将 `package.json` 中的容器键从：

```json
"activitybar": [
```

改为：

```json
"secondarySidebar": [
```

保留数组内的 `loopagent` 对象和 `contributes.views.loopagent` 不变。

- [x] **步骤 4：运行受影响验证**

运行：`npx vitest run test/packageManifest.test.ts`

预期：所有 manifest 测试通过。

- [x] **步骤 5：集中验证与安装**

依次运行：

```powershell
npm test
npm run typecheck
npm run compile
git diff --check
npm run package:vsix
code.cmd --install-extension .artifacts\\loopagent-vscode-0.0.1.vsix --force
code.cmd --list-extensions --show-versions | Select-String '^local-dev\\.loopagent-vscode@'
```

预期：测试、类型检查、编译和差异检查均成功；CLI 显示 `local-dev.loopagent-vscode@0.0.1`。重载当前 VS Code 窗口后，确认 LoopAgent 位于右侧副侧边栏。

- [x] **步骤 6：记录结果并提交**

在本计划末尾添加中文实施记录，包含实际命令结果、VSIX 安装结果和视觉验证结果。提交：

```powershell
git add package.json test/packageManifest.test.ts docs/superpowers/plans/2026-07-17-right-secondary-sidebar-plan.md
git commit -m "fix(ui): place chat in right sidebar"
```

## 计划自检

- 规格中的所有范围项都由 Task 1 覆盖。
- 容器键、ID、视图 ID 和命令 ID 在所有步骤中一致。
- 不包含占位步骤或未定义的实现接口。

## 实施记录

### 2026-07-17

- 初始的 `auxiliarybar` 尝试通过了静态测试，但重载后右侧副侧边栏没有出现 LoopAgent；检查本机 VS Code 的 `viewsContainers` 处理器后，确认有效键为 `secondarySidebar`。
- 将测试先改为要求 `secondarySidebar`，验证旧 manifest 按预期失败；迁移 `package.json` 后，`npx vitest run test/packageManifest.test.ts` 通过（3/3）。
- 集中验证通过：`npm test` 为 51 个测试文件、296 个测试全部通过；`npm run typecheck`、`npm run compile` 和 `git diff --check` 成功。
- 已重新打包并覆盖安装 `.artifacts/loopagent-vscode-0.0.1.vsix`；CLI 确认 `local-dev.loopagent-vscode@0.0.1`。
- 重载 VS Code 后，可访问性树显示左侧活动栏不再有 LoopAgent，右侧副侧边栏的活动视图列表出现 `LoopAgent`，与 Chat、Codex 并列。
