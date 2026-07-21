# 移除 Fake 模型提供方设计

## 目标

删除运行时、配置、Webview 选项和测试中的 Fake 模型提供方，LoopAgent 只保留 DeepSeek 模型路径。

## 非目标

测试夹具中的 `FakeVsCodeApi`、`FakeWorker`、fake clock 等用于隔离外部依赖，不是模型提供方，本次保留。

## 用户可见行为

- 模型配置只允许 `deepseek`，默认值为 `deepseek`。
- Webview 不再显示 `Fake local`，发送任务时只能携带 DeepSeek 选择。
- 设置模型 API Key 直接针对 DeepSeek，不再提示先选择真实提供方。

## 涉及文件

- `src/extension/model/modelConfig.ts`
- `src/extension/model/modelRuntimeConfig.ts`
- `src/extension/model/providerRegistry.ts`
- `src/extension/fakeRun.ts`
- `src/shared/messages.ts`
- `src/shared/chatTypes.ts`
- `src/webview/App.tsx`
- `src/extension.ts`
- `package.json`
- `test/modelConfig.test.ts`
- `test/App.test.tsx`

## 关键决策

删除 `fakeAgentRunner` 及其测试，不保留无密钥降级路径；DeepSeek 配置错误时仍使用唯一的 DeepSeek 提供方。

## 验证方式

```powershell
npm test
npm run typecheck
npm run compile
git diff --check
```

## 后续事项

历史设计和验证文档中的 Fake provider 描述作为归档记录保留，不参与运行时或构建产物。
