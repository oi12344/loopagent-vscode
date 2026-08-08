# 本地目录不提交设计

## 目标

将本地索引、测试临时产物、调试记录和会话计划目录保留在开发机上，但从 Git 远程仓库移除并阻止后续提交。

## 非目标

- 不删除开发机上的目录或文件。
- 不改动 `origin` 远程地址、分支或历史提交。
- 不处理截图之外的用户已有改动，例如 `blog/`。

## 用户可见行为

以下目录从版本索引移除，且之后由根目录 `.gitignore` 忽略：

- `.codegraph/`
- `.e2e-multifile-scratch/`
- `.playwright-mcp/`
- `.superpowers/sdd/`
- `.vscode/`
- `.zcode/plans/`

本地目录继续存在；需要提交其中内容时，必须显式使用 `git add -f`。

## 涉及文件

- `.gitignore`
- `docs/superpowers/specs/2026-08-09-ignore-local-directories-design.md`
- `docs/superpowers/plans/2026-08-09-ignore-local-directories-plan.md`
- `docs/superpowers/INDEX.md`

## 验证方式

使用 `git ls-files`、`git check-ignore`、`git status --short` 和 `git diff --check` 确认索引清理、忽略规则及现有改动边界。

## 已知后续工作

远程仓库中的历史提交仍保留这些目录；本次只移除当前分支的最新快照，历史清理需另行确认并重写历史。
