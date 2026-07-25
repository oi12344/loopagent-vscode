# 编辑审批架构改进 — 立即应用 + 事后撤销

**日期**: 2026-07-25  
**状态**: ✓ 已实现

## 目标与结果

原计划：逐步保留阻塞式审批机制，加入逐文件选择。

**实际改进**：彻底移除阻塞式审批，改为立即应用、事后撤销——更敏捷，风险转移到用户可控的撤销流程。

## 架构变化

### 旧流程
```
Agent 调用 applyEdit()
  → openPreviews() 打开所有文件的 diff 标签
  → 阻塞等待 EditApprovalBroker.approve()（webview 卡片或原生弹窗）
  → 用户批准/拒绝某些文件
  → 仅应用被批准文件
  → 返回结果
```

### 新流程
```
Agent 调用 applyEdit()
  → 直接 applyEdit() 写入工作区（全部改动）
  → 触发 notify 回调，webview 收到 editApplied 消息
  → 返回结果（立即，不等待用户）
  → 用户在卡片上按需点 editRevertRequested 撤销某些文件
  → 或点文件名通过 editFileOpened 打开 diff（按需预览）
```

## 实现清单

- ✓ `src/shared/messages.ts` — 消息协议改为 `editApplied`、`editRevertRequested`、`editFileOpened`（火和忘机制）
- ✓ `src/extension/agent/editPreviewService.ts` — 
  - `apply()` 直接写盘，触发 `notify()`，不再阻塞
  - 新增 `revertFiles(notificationId, paths)` — 按文件撤销
  - 新增 `openFilePreview(notificationId, path)` — 按需打开 diff
  - 删除 `openPreviews`、`closePreviewTabs`、`snapshotsStillMatch`（不再需要）
  - `EditApprovalRequest`/`EditApprover` 类型删除，改为 `EditApplicationNotice`/`EditApplicationNotifier`
- ✓ `src/extension/agent/editApprovalBroker.ts` — 完全删除（无需阻塞审批）
- ✓ `src/extension.ts` — 
  - `editPreviewService` 的 `notify` 直接 `postMessage(editApplied)`
  - 消息处理改为 `editRevertRequested`/`editFileOpened`（异步，不是审批应答）
  - 删除原生 fallback 弹窗（所有改动都立即应用）
- ✓ `src/webview/App.tsx` — 
  - `EditApprovalCard` 变为"应用后通知卡片"
  - 「保留」= 本地关闭卡片（无消息回传）
  - 「撤销」= `editRevertRequested`（整体或单文件）
  - 行内撤销按钮 = 按需发送单文件撤销
  - 差异展示 = 按文件累计 +X/-Y 统计
- ✓ `src/webview/styles.css` — 更新卡片样式，移除已撤销状态样式（改为卡片消失）
- ✓ `src/extension/agent/applyEditTool.ts` — 更新描述说明直接应用
- ✓ `test/editTools.test.ts` — 
  - 删除所有 `approve` 模拟（不再有审批）
  - 改为 `notify` 机制
  - 添加 `revertFiles` 单文件撤销测试
  - 删除无关的 diff 预览前置测试
- ✓ `test/App.test.tsx` — 
  - `editApprovalRequested` → `editApplied`
  - 「保留」/「撤销」/单文件撤销逻辑测试
- ✓ 删除 `test/editApprovalBroker.test.ts`

## 设计权衡

| 维度 | 旧方案 | 新方案 | 权衡 |
|------|--------|--------|------|
| 审批时机 | 预览中阻塞 | 应用后反应 | 更快迭代，但用户需在卡片上做决定 |
| 撤销精度 | 应用前全选或全拒 | 应用后按文件撤销 | 灵活性更高，用户体验更好 |
| 失败成本 | 不写盘 | 先写盘，再撤销 | Agent 错误代价更高，需要扣 `undoLast` 命令恢复 |
| 预览方式 | 自动打开所有 diff | 按需打开（点击文件） | 省资源，用户掌控 |

## 关键假设与风险

1. **Agent 信任度**: 现在 Agent 可以无条件地改工作区文件。这要求 Agent 有充分的推理能力和自检机制，否则错误改动会先发生再撤销。
2. **用户习惯**: 用户需要知道「保留」只是关闭卡片（改动已在盘上），撤销才是反向改。
3. **并发安全**: 如果用户在卡片弹出期间手动编辑某个文件，撤销可能冲突。当前依赖 VSCode 的 `WorkspaceEdit` 一致性保证。

## 验证状态

✓ `npx tsc --noEmit` — 无类型错误  
✓ `npx vitest run` — 68 files / 549 tests 全过
