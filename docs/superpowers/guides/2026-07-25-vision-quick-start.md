# 视觉模型集成 - 快速入门

这是一个完整的工作示例，展示如何使用视觉模型增强 DeepSeek V4 Flash 的代码编辑分析能力。

## 📦 文件清单

本次实现创建了以下文件：

### 核心类型定义
- `src/extension/vision/types.ts` - 视觉服务类型定义

### Python 视觉服务
- `python/vision_server.py` - Moondream2 HTTP 服务器
- `python/requirements.txt` - Python 依赖清单

### TypeScript 客户端
- `src/extension/vision/localVisionService.ts` - 本地视觉服务封装
- `src/extension/vision/screenshotCapture.ts` - 截图捕获工具
- `src/extension/vision/hybridInference.ts` - 混合推理服务
- `src/extension/vision/visionAnalysisTool.ts` - Agent 工具集成

### 测试与文档
- `test/visionIntegration.test.ts` - 集成测试
- `docs/vision-integration-guide.md` - 完整使用指南

## 🚀 5 分钟快速开始

### 步骤 1：安装依赖

```bash
# 安装 Python 依赖（首次运行，约 2-3 分钟）
pip install -r python/requirements.txt

# 验证安装
python -c "import torch; import transformers; print('✅ 依赖安装成功')"
```

### 步骤 2：测试视觉服务

```bash
# 启动服务器（首次会自动下载模型 ~1.6GB，需要 5-10 分钟）
python python/vision_server.py

# 等待看到：[Vision] Model loaded successfully
```

在另一个终端测试：

```bash
# 健康检查
curl http://127.0.0.1:8765/health

# 输出示例：
# {"status":"healthy","model_loaded":true,"provider":"moondream2"}
```

### 步骤 3：运行测试

```bash
# 运行集成测试
npm test -- visionIntegration.test.ts

# 预期输出：
# ✅ Vision service started
# ✅ should pass health check (125ms)
# ✅ should analyze a screenshot (1823ms)
```

## 💡 实际使用示例

### 示例 1：验证代码编辑

假设用户重命名了一个函数，AI 需要验证是否所有引用都已更新：

```typescript
// 用户的编辑操作
const changes: EditOperation[] = [
  {
    kind: "replace",
    path: "src/user.ts",
    oldText: "function getUserName(id: string) { return db.users.find(id).name; }",
    newText: "function getUsername(id: string) { return db.users.find(id).name; }",
  }
];

// AI 调用视觉分析工具
const result = await analyzeEditWithVision({
  changes,
  captureScreenshot: true,
  analysisGoal: "verify_changes"
});

// 返回结果示例：
/*
## 📸 视觉分析
**可见改动：**
- 第 12 行：函数名从 getUserName 改为 getUsername

**错误标记：**
- ⚠️ 第 45 行：未定义的函数 'getUserName'（红色波浪线）

## 🔍 深度分析
**改动应用状态：** ❌ 存在问题

**发现的问题：**
❌ src/app.ts:45 仍在调用旧函数名 getUserName
❌ src/profile.ts:23 也需要更新

**改进建议：**
- 使用 VSCode 的"重命名符号"功能（F2）确保全局更新
- 运行测试验证功能完整性
*/
```

### 示例 2：检测引入的错误

```typescript
// 用户修改了类型定义
const changes: EditOperation[] = [
  {
    kind: "replace",
    path: "src/types.ts",
    oldText: "interface User { id: string; name: string; }",
    newText: "interface User { id: number; name: string; }",
  }
];

// AI 分析
const result = await analyzeEditWithVision({
  changes,
  captureScreenshot: true,
  analysisGoal: "detect_errors"
});

// 视觉模型会识别编辑器中出现的所有红色波浪线
// DeepSeek 会分析："将 id 从 string 改为 number 后，
// 所有传递字符串 ID 的地方都报错了，需要全局迁移"
```

### 示例 3：自定义分析

```typescript
// 用户添加了新功能，想评估代码质量
const result = await analyzeEditWithVision({
  changes: newFeatureChanges,
  captureScreenshot: true,
  analysisGoal: "custom",
  customPrompt: `评估这次新增功能的代码质量，重点关注：
1. 是否有明显的性能问题（如 N+1 查询）
2. 错误处理是否完善
3. 是否符合项目的代码风格
4. 是否需要添加单元测试`
});
```

## 🎯 集成到现有工作流

### 在 Agent 中使用

修改 `src/extension/agent/reactAgentRunner.ts`，注册视觉工具：

```typescript
import { createAnalyzeEditWithVisionTool } from "../vision/visionAnalysisTool";

// 在 createReactAgent 函数中
const tools: ReactAgentTool[] = [
  createReadFileTool(context),
  createApplyEditTool(editPreviewService),
  createRunCommandTool(commandBroker),
  
  // 新增：视觉分析工具
  createAnalyzeEditWithVisionTool(hybridInferenceService, screenshotService),
];
```

现在 AI 可以在对话中自动使用这个工具：

```
User: 帮我把 getUserName 重命名为 getUsername

AI: 我将执行以下操作：
1. 使用 grep 找到所有引用
2. 应用重命名编辑
3. 使用视觉模型验证改动

[调用 applyEdit...]
[调用 analyzeEditWithVision...]

✅ 重命名完成！视觉分析显示：
- 成功修改了 3 处引用
- 未发现错误标记
- 所有测试通过
```

## 📊 性能优化技巧

### 1. 延迟加载模型

模型仅在首次调用 `/analyze` 时加载，而非服务启动时：

```python
# vision_server.py 已实现
def load_model():
    global _model, _model_loaded
    if _model_loaded:
        return _model
    # ... 加载逻辑
```

### 2. 缓存截图分析结果

```typescript
const analysisCache = new Map<string, VisionAnalysisResult>();

async function analyzeWithCache(imagePath: string, prompt: string) {
  const cacheKey = `${imagePath}-${prompt}`;
  if (analysisCache.has(cacheKey)) {
    return analysisCache.get(cacheKey)!;
  }
  
  const result = await visionService.analyze({ imagePath, prompt, signal });
  analysisCache.set(cacheKey, result);
  return result;
}
```

### 3. 并行处理多个截图

```typescript
const screenshots = [shot1, shot2, shot3];
const results = await Promise.all(
  screenshots.map(shot => visionService.analyze({
    imagePath: shot.filePath,
    prompt: "Detect errors",
    signal
  }))
);
```

## 🐛 常见问题

### Q: 首次启动很慢？
A: 正常现象。首次启动会下载 1.6GB 模型，后续启动仅需 2-5 秒。

### Q: 可以离线使用吗？
A: 可以！模型下载后会缓存在 `~/.cache/huggingface/`，之后可完全离线运行。

### Q: 分析一张截图要多久？
A: CPU 模式约 0.5-3 秒，GPU 模式约 0.2-1 秒。

### Q: 支持哪些编程语言？
A: Moondream2 是通用视觉模型，支持所有编程语言的代码截图。

### Q: 如何提高识别准确度？
A: 
1. 使用更具体的提示词
2. 确保截图清晰（高 DPI）
3. 等待编辑器完全渲染后再截图（增加 `delayMs`）

## 🎓 进阶学习

### 了解混合推理流程

```typescript
// 步骤 1：捕获截图
const screenshot = await screenshotService.captureActiveEditor();

// 步骤 2：视觉模型提取结构化信息
const visualInsights = await visionService.analyze({
  imagePath: screenshot.filePath,
  prompt: "列出所有错误标记和改动",
  signal
});

// 步骤 3：将视觉信息作为上下文传递给 DeepSeek
const deepAnalysis = await deepseekModel.chat([
  { role: "user", content: `
    用户应用了以下改动：
    ${JSON.stringify(changes)}
    
    编辑器截图显示：
    ${visualInsights.text}
    
    请分析改动是否正确，是否有潜在问题。
  `}
]);

// 步骤 4：合并结果返回
return { visualInsights, deepAnalysis };
```

### 自定义视觉提示词

针对不同场景优化提示词：

```typescript
// 错误检测
const errorPrompt = `识别代码编辑器中的所有错误指示器：
1. 红色波浪线（语法/类型错误）
2. 黄色波浪线（警告）
3. 灯泡图标（建议）
4. 错误计数徽章
对每个错误，说明行号和可能的错误类型。`;

// UI 变化检测
const uiPrompt = `对比这两张截图，列出所有 UI 变化：
- 新增/删除的按钮或控件
- 颜色变化
- 布局调整
- 文字内容修改`;

// 代码质量评估
const qualityPrompt = `评估这段代码的视觉特征：
- 缩进是否一致
- 是否有过长的行（超过屏幕宽度）
- 是否有大块注释代码（应删除）
- 颜色高亮是否正常（无异常高亮）`;
```

## ✨ Insight ─────────────────────────────────────
- **视觉 + 文本 = 更强理解**：视觉模型看到"红色波浪线"，文本模型推理"为什么会有这个错误"
- **本地优先**：无隐私泄露，无网络依赖，完全可控
- **渐进增强**：视觉功能失败时自动降级到纯文本分析，不影响核心功能
─────────────────────────────────────────────────

## 📚 下一步

1. **阅读完整指南**：[vision-integration-guide.md](./vision-integration-guide.md)
2. **运行测试**：`npm test -- visionIntegration.test.ts`
3. **查看示例代码**：`test/visionIntegration.test.ts`
4. **探索 API**：`src/extension/vision/types.ts`

祝你使用愉快！有问题欢迎提 Issue。
