# 代码生成与编辑预览设计

## 目标

让 LoopAgent 能读取完整文件、提出代码修改，并通过 VS Code 原生 Diff 显示红色删除与绿色新增。用户审阅整份提案后一次确认，才将变更写入工作区。

## 范围

第一版支持：

- 修改已有文件中的精确文本。
- 创建新文件。
- 重命名文件。
- 删除文件。
- 一个提案中的全部文件变更一次确认或一次取消。

不支持 Git 提交、自动执行终端命令、自动保存、自动确认、二进制文件编辑或工作区外路径。

## 架构

新增两个 Agent 工具：

1. `readFile`：读取工作区内一个文本文件的完整内容或指定行区间，供模型形成精确编辑。
2. `applyEdit`：接收结构化编辑提案，构建虚拟预览、等待用户确认，并在确认后调用 `vscode.workspace.applyEdit`。

`applyEdit` 不声明 `isConcurrencySafe`，因此会沿用 Runner 的串行执行规则。`readFile` 是只读工具，可声明为并发安全。

提案在 Extension Host 内保存原始文件快照和计算后的目标文本。预览使用 `TextDocumentContentProvider` 提供 `loopagent-edit-preview:` 虚拟 URI，并通过 `vscode.commands.executeCommand("vscode.diff", ...)` 打开原生 Diff 标签页；不会修改真实文件。

## 工具契约

```typescript
type ReadFileInput = {
  path: string;
  startLine?: number;
  endLine?: number;
};

type EditOperation =
  | { kind: "replace"; path: string; oldText: string; newText: string }
  | { kind: "create"; path: string; content: string }
  | { kind: "rename"; from: string; to: string }
  | { kind: "delete"; path: string };

type ApplyEditInput = {
  changes: EditOperation[];
};
```

`replace` 的 `oldText` 不能为空，且必须在当前暂存文本中恰好出现一次。Host 按提案顺序计算每个文件的目标文本，因此一个文件可有多个连续的 `replace`。路径必须是相对工作区根目录的普通文件路径，不允许绝对路径、`..`、空路径或目录目标。

`readFile` 默认最多返回 20,000 个字符；超过时截断并明确告知模型应使用更窄的行区间。行号从 1 开始，`startLine` 与 `endLine` 必须同时是正整数且 `startLine <= endLine`。它复用现有 `isIndexableWorkspacePath`，拒绝 `.env`、密钥相关路径、`.git`、依赖和构建目录，避免把敏感内容回灌给模型。路径的每个已存在组件不得是符号链接；已打开但未保存的目标文档也会被拒绝，确保预览内容与最终写入针对同一已保存快照。

同一提案不得对同一路径同时执行冲突操作，例如删除后替换、重命名后删除，或创建已存在文件。遇到无效输入、冲突、读取失败或文本不匹配时，整个提案不显示确认按钮且不写入任何文件。

## 审阅与应用流程

```text
模型 -> readFile / exploreCode
模型 -> applyEdit(结构化提案)
Host -> 校验、读取快照、计算目标文本
Host -> 为每个受影响文件打开原生 Diff
用户 -> "应用全部" 或 "取消"
Host -> 重新确认快照未变化 -> WorkspaceEdit
Host -> 将应用、取消或冲突结果作为 tool observation 回灌模型
```

Diff 规则：

- 修改：真实文件 URI 对比目标虚拟 URI。
- 创建：空内容虚拟 URI 对比目标虚拟 URI。
- 删除：真实文件 URI 对比空内容虚拟 URI。
- 重命名：旧路径与新路径内容对比，并在标题中展示两个路径。

所有 Diff 打开后，Host 使用一个模态 `showInformationMessage` 提供“应用全部”和“取消”。用户关闭提示等同于取消。确认前重新解析所有源/目标路径，重复检查符号链接、未保存文档、目标不存在性和源文件快照；任一变化则拒绝整个提案，并把冲突说明返回模型。`file` URI 的文档匹配按大小写不敏感的 `fsPath` 比较，防止 Windows 大小写差异绕过脏文档保护。`workspace.applyEdit` 返回 `false` 时报告失败，不自动重试或部分补救。

如果用户在审阅期间取消 Agent run，或在确认后、写入前收到取消信号，Host 不应用提案；Runner 按现有取消语义结束，不继续模型回合。

## 提示词与运行时边界

生产提示词增加：需要改代码时先读取相关文件；只通过 `applyEdit` 提出变更；不得声称修改已经完成，直到工具 observation 明确报告应用成功。

工具可在一次 ReAct 步骤中提出编辑提案，但 Runner 等待用户审阅完成后才继续下一模型步骤。用户取消、冲突或应用失败均作为普通工具结果回灌，模型可解释原因或提出修订提案；不会自动再次写入。

## 验证

- `readFile` 对完整内容、行区间、无效路径、超出工作区路径、敏感路径、符号链接和未保存文档的处理。
- `applyEdit` 对 `replace`、创建、重命名、删除和多操作提案生成正确的虚拟 Diff 内容。
- 用户取消、关闭确认框、快照冲突、未保存文档、符号链接和 `WorkspaceEdit` 返回 `false` 时均不改文件。
- 用户确认后仅应用计算出的全部变更，并将成功 observation 交给下一模型步骤。
- `applyEdit` 与其他工具同轮出现时保持串行；`readFile` 可与其他只读工具并发。
- 在 Extension Development Host 中手动检查原生 Diff 的红绿显示和“应用全部/取消”行为。

## 相关文件

- `src/extension/agent/reactTypes.ts`
- `src/extension/agent/reactAgentRunner.ts`
- `src/extension/agent/tools.ts`
- `src/extension/model/providerRegistry.ts`
- `src/extension.ts`
- `src/shared/messages.ts`
- `test/reactAgentRunner.test.ts`
- 新增的编辑工具与 VS Code 适配测试文件
