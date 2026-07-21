# 历史菜单定位修复设计

## 根因

底部工具菜单和顶部 History 菜单共用向上展开的定位规则。History 位于 header 顶部，菜单因此渲染到视口上方，真实鼠标无法点击菜单项。

## 方案

History 菜单增加独立的 `history-menu` class，使用 `top: calc(100% + 6px)` 向下展开并右对齐；底部模型和思考菜单保持原定位。

## 验证

- `test/App.test.tsx` 约束 History 菜单带有独立定位 class。
- 在唯一 VS Code 调试窗口中检查菜单矩形位于视口内，并用真实鼠标坐标点击历史项。
- 运行 `npm test`、`npm run typecheck`、`npm run compile` 和 `git diff --check`。
