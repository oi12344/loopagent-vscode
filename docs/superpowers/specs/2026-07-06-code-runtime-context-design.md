# 代码运行时上下文设计

## 背景

LoopAgent 已经具备侧边栏 Chat View、DeepSeek v4 flash 模型接入、流式回答、模型选择和深度思考开关。当前模型收到的主要是用户输入文本，缺少对 VS Code 工作区和当前代码状态的理解。

下一步需要构建一个代码运行时上下文，让模型在回答前获得当前项目的关键只读信息。

## 目标

为每次 `startTask` 构建一份 `CodeRuntimeContext`，在调用模型前注入到 prompt 中，使模型能理解：

- 当前工作区根目录和项目类型。
- 当前活跃文件、可见编辑器和打开文件。
- 用户选中的文本或光标附近上下文。
- 项目 manifest 和常用脚本，例如 `package.json` scripts。
- VS Code diagnostics，例如 TypeScript 或构建错误。
- 受限数量的相关文件摘要。

## 非目标

- 不执行任意 shell 命令。
- 不让模型直接读全仓库。
- 不实现文件修改工具、终端工具或自动测试工具。
- 不实现长期记忆、向量索引或跨会话缓存。
- 不把敏感文件、环境变量、SecretStorage 内容加入上下文。

## 推荐范围

第一阶段只做只读、轻量、可解释的“单次请求上下文快照”。这里的“存”不是长期记忆，也不是向量索引，而是在用户发送消息时临时收集一份当前 VS Code 状态，随本次模型调用注入 prompt。run 结束后默认丢弃，除非后续明确设计调试日志或用户可见的上下文预览。

`CodeRuntimeContext` 建议包含：

```ts
type CodeRuntimeContext = {
  version: 1;
  collectedAt: string;
  workspace: {
    name: string;
    roots: string[];
  };
  activeEditor?: {
    path: string;
    languageId: string;
    lineCount: number;
    cursor?: {
      line: number;
      character: number;
    };
    selectionText?: string;
    surroundingText?: string;
  };
  visibleEditors: Array<{
    path: string;
    languageId: string;
  }>;
  openTabs: Array<{
    path: string;
    languageId?: string;
    isActive: boolean;
    isDirty: boolean;
    isPinned?: boolean;
  }>;
  projectFiles: Array<{
    path: string;
    kind: "manifest" | "config" | "doc";
    summary: string;
  }>;
  diagnostics: Array<{
    path: string;
    severity: "error" | "warning" | "information" | "hint";
    message: string;
    line: number;
  }>;
  budget: {
    maxChars: number;
    usedChars: number;
    truncated: boolean;
  };
};
```

字段含义：

- `activeEditor`：当前焦点所在编辑器，优先提供用户正在看的文件。
- `visibleEditors`：当前布局里真正可见的编辑器组内容，通常是分屏后同时露出的文件，不等同于所有 tab。
- `openTabs`：当前 VS Code 已打开的文件 tab 列表，用来帮助模型理解用户最近关注的文件集合，但第一阶段只记录路径和轻量状态。
- `selectionText`：用户有选区时优先收集，是最高价值上下文。
- `surroundingText`：没有选区时，收集光标附近有限行数，避免把整个文件塞进 prompt。
- `projectFiles`：只放小型项目线索，例如 manifest、配置和稳定开发文档的摘要。
- `diagnostics`：只放错误和警告的精简位置与消息，帮助模型理解当前真实问题。
- `budget`：记录本次上下文是否被截断，方便测试和后续 UI 解释。

## 上下文优先级

上下文必须按价值分层，不能“能拿多少拿多少”：

1. P0：用户输入、当前活动文件路径/语言、选区文本；没有选区时使用光标附近代码；活动文件 diagnostics。
2. P1：打开的 tab 列表、可见编辑器列表、workspace 根目录、`package.json` scripts 和关键 dependencies。
3. P2：小型配置和文档摘要，例如 `tsconfig.json`、`README.md`、`docs/development.md`，以及 workspace 级高优先级 diagnostics。
4. P3：与用户问题或打开 tab 词法相关的少量文件片段。第一阶段可以暂不实现，只保留接口空间。

预算不足时从 P3 开始丢弃，再丢 P2，最后裁剪 P1；P0 只做长度裁剪，不整体移除。

## 关键取舍

### 方案 A：只读上下文构建器

优点：

- 风险低，适合当前阶段。
- 容易测试，输入输出清晰。
- 能明显提升模型回答质量。

缺点：

- 不能主动运行测试或检查真实命令输出。

### 方案 B：上下文 + 命令执行

优点：

- 能获取更真实的运行结果。

缺点：

- 权限、安全和超时控制复杂。
- 容易和未来工具系统耦合。

### 方案 C：全仓库索引

优点：

- 检索能力更强。

缺点：

- 实现重，缓存、增量更新和 token 控制都需要单独设计。

本阶段选择方案 A。

## 与工具系统的关系

第一阶段不新增模型可调用工具，而是在扩展 host 侧构建上下文并注入模型消息。原因是：

- 上下文快照是每次对话都需要的基础输入，适合自动收集。
- 工具调用需要权限、确认、超时、错误回传和审计 UI，应该作为后续独立能力设计。
- 先把上下文结构稳定下来，后续工具可以复用同一套 `CodeRuntimeContext` 类型作为调用前状态。

未来如果新增工具，建议按能力拆分，例如 `readWorkspaceFile`、`searchWorkspace`、`runCommand`、`applyPatch`，不要把所有运行时能力塞进一个大工具。

## 架构设计

新增扩展侧模块：

- `src/extension/runtime/codeRuntimeContext.ts`
  - 定义 `CodeRuntimeContext` 类型。
  - 提供 `createCodeRuntimeContext(context, task)`。
  - 只使用 VS Code API 和受控文件读取。

- `src/extension/runtime/contextPrompt.ts`
  - 将 `CodeRuntimeContext` 格式化为模型可读的 system 或 user context block。
  - 控制最大字符数，避免 prompt 过长。

修改：

- `src/extension/model/modelRunner.ts`
  - 支持可选 `runtimeContextProvider`。
  - 调模型前发送 `assistantThinking: Building code context`。
  - 将格式化后的上下文加入 messages。

- `src/extension/model/providerRegistry.ts`
  - 创建模型 runner 时注入默认 runtime context provider。

## 上下文收集规则

- 活跃文件：优先包含选中文本；没有选区时包含光标附近有限行数。
- 可见编辑器：只记录当前编辑器布局中可见文件的路径和语言，不默认读取全文。
- 打开 tab：记录所有已打开文件 tab 的路径、激活状态、dirty 状态和 pinned 状态，不默认读取全文。
- manifest/config/doc：只读取小文件，例如 `package.json`、`tsconfig.json`、`README.md`、`docs/development.md`。
- diagnostics：最多收集前 20 条，按 error 优先。
- 文件路径：使用 workspace 相对路径。
- 大文件：跳过或截断。
- 排除目录：`node_modules`、`dist`、`.git`、`.local-vscode-*`。

## 裁剪策略

- 默认上下文预算先按字符数控制，第一阶段建议 `maxChars = 12000`，后续再按模型 token 能力细化。
- 单个选区最多保留 6000 字符，超出时保留开头和结尾，中间标注截断。
- 光标附近上下文默认收集前后各 80 行，并受单文件字符预算约束。
- `projectFiles.summary` 不存完整文件，`package.json` 只提取 name、scripts、dependencies/devDependencies 的包名，配置文件保留关键字段摘要。
- diagnostics 先按 severity 排序，再按活动文件优先，最多 20 条。
- formatter 输出时必须明确标记哪些内容被截断，避免模型误以为上下文完整。

## 安全边界

- 不读取 `.env`、key、token、SecretStorage。
- 不读取二进制文件。
- 不把用户提供的真实 API key 写入上下文、日志或文档。
- 上下文只读，不产生文件写入或命令执行。

## 验证方式

- 单元测试覆盖：
  - 活跃文件选区进入上下文。
  - 大文件截断。
  - excluded 目录不进入上下文。
  - diagnostics 按严重级别和数量限制输出。
  - prompt formatter 不超过最大长度。

- runner 测试覆盖：
  - 发送 `Building code context` 过程事件。
  - 模型 messages 中包含格式化后的上下文。
  - 上下文 provider 失败时不阻断整个 run，而是发送可见的过程提示并继续回答。

## 后续阶段

完成只读上下文后，再设计：

- 代码检索策略。
- 受控命令执行。
- 文件编辑工具。
- 测试运行工具。
- 权限确认 UI。
