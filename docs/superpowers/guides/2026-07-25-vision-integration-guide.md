# 视觉模型集成指南

## 概述

本指南介绍如何为 DeepSeek V4 Flash（无视觉功能）集成本地轻量级视觉模型 **Moondream2**，实现代码编辑的视觉理解能力。

## 架构设计

```
┌─────────────────────────────────────────────────┐
│  VSCode Extension (TypeScript/Node.js)          │
├─────────────────────────────────────────────────┤
│                                                 │
│  ┌──────────────────┐      ┌─────────────────┐ │
│  │ Edit Preview     │──────│ Screenshot      │ │
│  │ Service          │      │ Capture         │ │
│  └──────────────────┘      └─────────────────┘ │
│           │                         │           │
│           └──────────┬──────────────┘           │
│                      ▼                           │
│           ┌──────────────────────┐              │
│           │ Hybrid Inference     │              │
│           │ Service              │              │
│           └──────────────────────┘              │
│                      │                           │
│          ┌───────────┴───────────┐              │
│          ▼                       ▼              │
│  ┌──────────────┐       ┌──────────────────┐   │
│  │ Local Vision │       │ DeepSeek V4      │   │
│  │ Service      │       │ Flash            │   │
│  └──────────────┘       └──────────────────┘   │
│          │                                      │
└──────────┼──────────────────────────────────────┘
           │ HTTP (127.0.0.1:8765)
           ▼
┌─────────────────────────────────────────────────┐
│  Python Vision Server (子进程)                   │
├─────────────────────────────────────────────────┤
│  - FastAPI HTTP 服务                            │
│  - Moondream2 模型 (1.6GB)                      │
│  - CPU/GPU 推理                                 │
└─────────────────────────────────────────────────┘
```

## 安装步骤

### 1. 系统要求

- **Node.js**: 18.x 或更高
- **Python**: 3.10 或更高
- **内存**: 至少 4GB RAM（推荐 8GB）
- **磁盘空间**: 约 3GB（模型文件 1.6GB + 依赖）
- **可选**: NVIDIA GPU + CUDA 12.1（加速推理）

### 2. 安装 Python 依赖

```bash
# 进入项目根目录
cd loopagent-vscode

# 安装 Python 依赖
pip install -r python/requirements.txt

# 可选：安装 GPU 版本 PyTorch（需要 CUDA 12.1）
# pip install torch --index-url https://download.pytorch.org/whl/cu121
```

**依赖说明**：
- `torch`: PyTorch 深度学习框架
- `transformers`: Hugging Face 模型库
- `fastapi` + `uvicorn`: Web 服务框架
- `pillow`: 图像处理库

### 3. 验证安装

```bash
# 启动视觉服务器（测试）
python python/vision_server.py --port 8765

# 在另一个终端测试健康检查
curl http://127.0.0.1:8765/health
# 预期输出: {"status":"healthy","model_loaded":false,"provider":"moondream2"}

# 首次访问 /analyze 端点时会自动下载模型（约 1.6GB）
```

## 使用方法

### 方式 1：在扩展中集成

编辑 `src/extension.ts`，在扩展激活时初始化视觉服务：

```typescript
import { LocalVisionService } from "./vision/localVisionService";
import { HybridInferenceService } from "./vision/hybridInference";
import { ScreenshotCaptureService } from "./vision/screenshotCapture";
import { createAnalyzeEditWithVisionTool } from "./vision/visionAnalysisTool";

export async function activate(context: vscode.ExtensionContext) {
  // ... 现有初始化代码

  // 初始化视觉服务
  const visionService = new LocalVisionService(context.extensionPath, {
    port: 8765,
    startupTimeoutMs: 30000, // 首次启动需要下载模型
  });

  // 启动视觉服务器（后台进程）
  try {
    await visionService.start();
    console.log("✅ Vision service started");
  } catch (error) {
    console.warn("⚠️  Vision service failed to start:", error);
    // 继续运行扩展，但禁用视觉功能
  }

  // 初始化截图服务
  const screenshotService = new ScreenshotCaptureService(context);

  // 创建混合推理服务
  const hybridService = new HybridInferenceService(
    visionService,
    async (prompt: string, signal: AbortSignal) => {
      // 调用 DeepSeek V4 Flash 进行文本推理
      return await callDeepSeekModel(prompt, signal);
    }
  );

  // 注册视觉分析工具（供 Agent 使用）
  const visionTool = createAnalyzeEditWithVisionTool(hybridService, screenshotService);
  toolRegistry.register(visionTool);

  // 清理资源
  context.subscriptions.push({
    dispose: async () => {
      await visionService.dispose();
      screenshotService.dispose();
    },
  });
}
```

### 方式 2：直接使用 API

```typescript
import { LocalVisionService } from "./vision/localVisionService";

// 初始化服务
const visionService = new LocalVisionService(extensionPath);
await visionService.start();

// 分析截图
const result = await visionService.analyze({
  imagePath: "/path/to/screenshot.png",
  prompt: "这个代码编辑器截图中有哪些错误标记？",
  signal: abortSignal,
});

console.log("分析结果:", result.text);
console.log("处理耗时:", result.processingTimeMs, "ms");
```

### 方式 3：AI Agent 调用工具

AI 可以在对话中调用 `analyzeEditWithVision` 工具：

```json
{
  "name": "analyzeEditWithVision",
  "input": {
    "changes": [
      {
        "kind": "replace",
        "path": "src/index.ts",
        "oldText": "function getUserName() { ... }",
        "newText": "function getUsername() { ... }"
      }
    ],
    "captureScreenshot": true,
    "analysisGoal": "detect_errors"
  }
}
```

返回格式化的分析结果：

```
## 📸 视觉分析
**可见改动：**
- 第 42 行：函数名从 getUserName 改为 getUsername
- 删除了 3 行注释

**错误标记：**
- ⚠️ 第 45 行：类型错误（红色波浪线）

## 🔍 深度分析
**改动应用状态：** ✅ 正确应用

**发现的问题：**
❌ 第 45 行调用处未更新函数名 (src/app.ts)

**改进建议：**
- 使用 IDE 的"重命名符号"功能确保所有引用同步更新
- 添加单元测试验证重命名后的功能

---
⏱️ 处理耗时: 1823ms
```

## 性能基准

基于 Intel i7-12700 + 16GB RAM（无 GPU）：

| 场景 | 平均耗时 | 说明 |
|------|---------|------|
| 健康检查 | ~50ms | HTTP 请求延迟 |
| 简单截图分析 | 500-1500ms | 代码编辑器，纯文本 |
| 复杂截图分析 | 1500-3000ms | 包含图表、UI 元素 |
| 混合推理（视觉+文本） | 2000-4000ms | 完整流程 |

**优化建议**：
- 使用 GPU 可减少 50-70% 推理时间
- 模型量化（INT8）可减少内存占用和推理时间
- 批量处理多张截图时，复用模型加载

## 故障排查

### 问题 1：Python 服务启动失败

**症状**：`Vision service failed to start within 30000ms`

**解决方案**：
1. 检查 Python 路径：`python --version`（需要 3.10+）
2. 检查依赖安装：`pip list | grep torch`
3. 增加启动超时：`startupTimeoutMs: 60000`
4. 查看 Python 错误日志（扩展输出面板）

### 问题 2：模型下载缓慢

**症状**：首次启动时长时间卡在 "Loading model..."

**解决方案**：
```bash
# 手动下载模型到缓存目录
export HF_HOME=~/.cache/huggingface
huggingface-cli download vikhyatk/moondream2

# 或使用国内镜像
export HF_ENDPOINT=https://hf-mirror.com
python python/vision_server.py
```

### 问题 3：分析结果不准确

**症状**：视觉模型识别代码错误不准确

**解决方案**：
1. **提高截图质量**：增加 `delayMs` 等待渲染完成
2. **优化提示词**：更具体地描述需要识别的内容
3. **使用更强模型**：考虑升级到 Florence-2 或 Qwen-VL

```typescript
// 示例：更具体的提示词
const result = await visionService.analyze({
  imagePath: screenshot,
  prompt: `分析这个 TypeScript 代码编辑器截图：
1. 列出所有红色波浪线标记的位置和错误类型
2. 识别黄色波浪线（警告）
3. 检查是否有语法高亮异常`,
  signal,
});
```

### 问题 4：内存不足

**症状**：`torch.cuda.OutOfMemoryError` 或进程崩溃

**解决方案**：
```python
# 修改 python/vision_server.py，启用低内存模式
model = AutoModelForCausalLM.from_pretrained(
    model_id,
    torch_dtype=torch.float16,  # 使用半精度
    low_cpu_mem_usage=True,
    device_map="auto"  # 自动分配设备
)
```

## 高级配置

### 启用 GPU 加速

```typescript
// 无需修改 TypeScript 代码，只需安装 GPU 版 PyTorch
// pip install torch --index-url https://download.pytorch.org/whl/cu121
```

Python 服务器会自动检测 CUDA 可用性并使用 GPU。

### 自定义端口

```typescript
const visionService = new LocalVisionService(extensionPath, {
  port: 9000, // 自定义端口
  host: "0.0.0.0", // 允许远程访问（不推荐）
});
```

### 调整健康检查频率

```typescript
const visionService = new LocalVisionService(extensionPath, {
  healthCheckIntervalMs: 10000, // 每 10 秒检查一次
});
```

## 下一步

- [ ] 集成 Florence-2 模型（更强的 UI 理解能力）
- [ ] 支持批量截图分析
- [ ] 添加模型量化（INT8/INT4）降低内存占用
- [ ] 实现截图缓存机制
- [ ] 支持视频流分析（实时编辑监控）

## 参考资源

- [Moondream2 官方文档](https://github.com/vikhyat/moondream)
- [Hugging Face Transformers](https://huggingface.co/docs/transformers)
- [VSCode Extension API](https://code.visualstudio.com/api)
- [FastAPI 文档](https://fastapi.tiangolo.com/)
