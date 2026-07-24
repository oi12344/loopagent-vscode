# 旧 Superpowers 运行时移除设计

## 目标

移除已经停用的内置 Superpowers 运行时、vendored skills、工作流 checkpoint 和 VSIX 打包依赖，保留当前 ReAct runner 与新子代理工作流作为唯一 agent 执行路径。

## 范围

- 删除 `resources/superpowers/`、`src/extension/superpowers/` 及对应测试。
- 删除 `providerRegistry.ts` 中旧 Edit/Superpowers runner 分支；配置后的 ReAct runner 不再依赖 skill catalog。
- 删除 `SuperpowersCheckpoint`、内存/SQLite 存储接口和已跳过的恢复测试。
- 删除 vendoring、资源枚举和 VSIX 资源完整性逻辑。
- 保留 `.superpowers/**` 的 VSIX 排除规则，避免本地开发记录进入扩展包。

## 行为边界

- 当前 ReAct runner、受控编辑/命令工具和子代理工作流不变。
- 新数据库不再创建 `superpowers_workflow` 表；已有数据库中的旧表不主动删除，避免升级时执行破坏性迁移。
- 普通 ReAct 中断 checkpoint 继续保存和恢复。
- VSIX 只验证实际运行所需的生产文件，不再携带旧 skills 资源。

## 风险控制

- 通过 provider 契约测试确认 runner 无旧资源也可创建和执行。
- 通过 VSIX 契约测试确认旧资源与辅助脚本不存在。
- 搜索生产源码，确保没有指向已删除模块的 import 或运行时路径。
- 执行类型检查、编译、全量测试、VSIX 打包和 `git diff --check`。

## 非目标

- 不修改新子代理工作流的调度、权限和记忆隔离。
- 不新增替代 skill 框架或角色管理 UI。
- 不删除用户已有数据库中的历史表。
