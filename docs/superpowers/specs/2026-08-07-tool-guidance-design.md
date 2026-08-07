# 工具 guidance 下沉设计

## 目标

把 `providerRegistry.ts` 中写死的工具专属使用说明，迁移到各自的工具定义里。以后新增或删除工具时，只需要改对应工具文件，不再需要同步修改全局系统提示词。

## 背景

当前系统提示词把工具使用建议集中在 `DIRECT_TOOL_GUIDANCE` 里，内容同时包含：

- 工具专属策略，例如 `browseSymbols` 先于 `exploreCode`
- 目录探索、编辑前置、命令执行等工具行为建议
- 与工具无关的通用原则，例如“证据足够就停止继续调用”

这种写法的问题是，工具定义和工具使用说明分离了。新增工具时，注册工具本身是一个地方，提示词又是另一个地方，容易漏改。

## 方案

### 1. 扩展工具接口

在 `ReactAgentTool` 上新增可选字段：

```ts
guidance?: string[];
```

选择 `string[]` 而不是单个字符串，原因是：

- 便于按条目组织提示
- 便于在不同工具之间拼接
- 便于在测试里精确断言某条建议是否存在

### 2. 工具自带使用说明

把原来 `DIRECT_TOOL_GUIDANCE` 中的工具专属内容迁移到对应工具文件：

- `browseSymbolsTool.ts`
- `exploreCodeTool.ts`
- `listDirectoryTool.ts`
- `readFileTool.ts`
- `applyEditTool.ts`
- `runCommandTool.ts`

每个工具只声明和自己相关的行为建议。例如：

- `browseSymbols` 说明它适合先发现符号名
- `exploreCode` 说明它适合在已有符号名时做精确查询
- `listDirectory` 说明它适合目录结构探索
- `readFile` 说明它适合在编辑前读取目标文件
- `applyEdit` 说明它适合直接提交完整编辑方案
- `runCommand` 说明它适合执行命令及处理自动恢复

### 3. 系统提示词自动聚合

`providerRegistry.ts` 不再维护工具专属常量，而是根据当前实际传入的工具数组聚合：

```ts
const toolGuidance = tools.flatMap((tool) => tool.guidance ?? []);
```

随后将 `basePrompt`、通用原则、`toolGuidance`、运行时上下文按顺序拼接。

这里保留的全局内容只包括不依赖具体工具的通用原则，例如：

- 证据足够就停止调用
- 只从工具返回证据回答
- 不要编造仓库事实

### 4. 子 agent 与 workflow 一致处理

父 runner 和 workflow 子 agent 都通过同一套提示词拼接逻辑处理各自可用工具。这样：

- 父 runner 只会得到父级工具的 guidance
- 子 agent 只会得到它实际拿到的工具 guidance
- workflow 生成的工具如果没有 guidance，不会额外注入说明

## 影响范围

### 需要改的文件

- `src/extension/agent/reactTypes.ts`
- `src/extension/agent/exploreCodeTool.ts`
- `src/extension/agent/browseSymbolsTool.ts`
- `src/extension/agent/listDirectoryTool.ts`
- `src/extension/agent/readFileTool.ts`
- `src/extension/agent/applyEditTool.ts`
- `src/extension/agent/runCommandTool.ts`
- `src/extension/model/providerRegistry.ts`
- `test/providerRegistryCodeContext.test.ts`
- 可能需要补一个专门验证 `guidance` 聚合的测试

### 不改的内容

- 不改工具输入 schema
- 不改工具执行逻辑
- 不改模型返回协议
- 不引入单独的 prompt registry 或配置文件

## 验证

1. `providerRegistry` 生成的系统提示词仍包含现有工具策略，但来源改为工具自身的 `guidance`
2. 新增一个带 `guidance` 的临时工具时，系统提示词会自动包含其说明
3. 未注册或未提供 `guidance` 的工具不会污染系统提示词
4. 现有 `providerRegistryCodeContext.test.ts` 继续通过，确保行为没有回退

## 取舍

这个设计不追求把所有提示词自动化到元数据层，只处理当前最痛的点：工具专属说明和工具定义脱钩。它保留了现有 `description` 的职责，不把“是什么”和“怎么用”混在一起，也避免再引入一个更重的 prompt 管理层。
