# 视觉功能使用指南

## 概述

LoopAgent 现在支持通过本地 Moondream2 视觉模型分析用户上传的图片。这使得 AI 能够"看到"设计稿、错误截图、文档等，并基于图片内容生成代码或提供帮助。

## 功能特点

### ✅ 通用图片识别能力

1. **UI/界面理解** - 分析设计稿并生成代码
2. **代码截图理解** - 识别代码片段
3. **图表/数据可视化** - 提取图表数据
4. **文档/表格提取** - 理解技术文档
5. **OCR（光学字符识别）** - 识别图片中的文字
6. **对象检测与计数** - 检测图片中的元素
7. **视觉问答（VQA）** - 回答关于图片的问题
8. **密集描述** - 详细描述图片内容

### 🎯 核心使用场景

#### 场景 1：设计稿转代码 ⭐⭐⭐⭐⭐

**操作步骤**：
1. 截图 Figma/Sketch 设计稿
2. 在 LoopAgent 对话框中粘贴图片
3. 输入："帮我实现这个登录页面"

**AI 工作流程**：
```
用户上传图片
    ↓
视觉模型分析（Moondream2）
  - 识别布局结构（卡片居中、三栏布局等）
  - 提取颜色方案（#4A90E2 蓝色渐变）
  - 识别组件（按钮、输入框、图标）
  - 测量尺寸比例（按钮高度 40px、圆角 4px）
    ↓
生成分析报告注入系统提示词
    ↓
DeepSeek V4 基于描述生成代码
  - HTML 结构
  - CSS 样式
  - 响应式布局
```

**示例输出**：
```html
<div class="login-page" style="background: linear-gradient(135deg, #4A90E2, #357ABD)">
  <div class="login-card">
    <img src="logo.png" class="logo" />
    <h1>欢迎登录</h1>
    <form>
      <div class="input-group">
        <i class="icon-email"></i>
        <input type="email" placeholder="请输入邮箱" />
      </div>
      <div class="input-group">
        <i class="icon-lock"></i>
        <input type="password" placeholder="请输入密码" />
      </div>
      <button class="btn-login">登录</button>
    </form>
  </div>
</div>
```

---

#### 场景 2：错误截图诊断 ⭐⭐⭐⭐⭐

**操作步骤**：
1. 遇到浏览器/编译器错误
2. 截图错误信息
3. 输入："这个错误怎么解决？"

**AI 工作流程**：
```
视觉模型识别错误信息
  - 错误类型：TypeError
  - 错误消息：Cannot read property 'name' of undefined
  - 文件位置：App.tsx:15:28
  - 堆栈跟踪
    ↓
AI 诊断
  - 读取 App.tsx 第 15 行代码
  - 分析根本原因
  - 提供修复方案
```

---

#### 场景 3：理解手绘草图 ⭐⭐⭐⭐

**操作步骤**：
1. 手绘页面布局草图
2. 拍照上传
3. 输入："按这个草图实现布局"

**视觉模型识别**：
```
手绘草图内容：
- 左侧：侧边栏（标注 200px）
- 中间：主内容区（标注 "flex-grow"）
- 右侧：信息面板（标注 300px）
- 顶部：导航栏（标注 60px 高）
```

**生成代码**：
```css
.layout {
  display: grid;
  grid-template-columns: 200px 1fr 300px;
  grid-template-rows: 60px 1fr;
  height: 100vh;
}
```

---

#### 场景 4：组件库文档理解 ⭐⭐⭐⭐

**操作步骤**：
1. 打开 Ant Design / Material UI 文档
2. 截图组件示例
3. 输入："帮我用这个样式实现按钮"

**视觉识别**：
```
文档显示多种按钮样式：
- Primary（蓝色实心）
- Default（白色边框）
- Dashed（虚线边框）
- Text（无边框）
- Danger（红色警告）
```

**生成代码**：
```tsx
import { Button } from 'antd';

<Button type="primary">提交</Button>
<Button type="default">取消</Button>
<Button type="dashed">草稿</Button>
<Button type="text">链接</Button>
<Button type="primary" danger>删除</Button>
```

---

## 技术架构

### 核心组件

```
用户上传图片
    ↓
WebView (App.tsx)
  - 接收图片附件
  - 传递给主进程
    ↓
Extension (extension.ts)
  - ImageAnalysisService 协调分析
    ↓
LocalVisionService
  - 启动 Python 子进程
  - 加载 Moondream2 模型（1.6GB）
  - HTTP API (localhost:8765)
    ↓
视觉模型推理
  - CPU/GPU 自动检测
  - 图片预处理（大小限制、缩放）
  - 生成图片描述
    ↓
返回分析结果
    ↓
ReactAgentRunner
  - 注入系统提示词
  - 附加图片分析结果
    ↓
DeepSeek V4 Flash
  - 基于图片描述生成代码
  - 回答用户问题
```

### 数据流

```typescript
// 1. 用户上传图片
WebviewToHostMessage {
  type: "startTask",
  task: "帮我实现这个页面",
  attachments: [
    {
      type: "image",
      path: "/tmp/design.png",
      name: "design.png",
      sizeBytes: 204800
    }
  ]
}

// 2. 图片分析
ImageAnalysisService.analyzeAttachments()
  ↓
VisionProvider.analyze({
  imagePath: "/tmp/design.png",
  prompt: "详细描述这个 UI 设计图，包括：布局、颜色、组件...",
  signal: AbortSignal
})
  ↓
VisionAnalysisResult {
  text: "这是一个登录页面设计，采用卡片式布局...",
  processingTimeMs: 150
}

// 3. 构建系统提示词
systemPrompt = `
You are LoopAgent, a coding assistant...

## 📸 用户上传的图片分析

### 图片 1：design.png

这是一个登录页面设计，采用卡片式布局...
- 背景：渐变蓝色 (#4A90E2 → #357ABD)
- 卡片：白色，居中，圆角 8px，阴影
- 组件：Logo、标题、输入框、按钮

*分析耗时：150ms*

请根据上述图片内容回答用户的问题。
`

// 4. AI 生成代码
DeepSeek V4 基于图片描述生成完整的 HTML + CSS
```

---

## 安装与配置

### 前置条件

1. **Python 3.8+**（用于运行视觉模型）
2. **PyTorch**（自动检测 CPU/GPU）
3. **Moondream2 模型**（首次运行时自动下载，约 1.6GB）

### 配置 Python 路径（可选）

在 VS Code 设置中配置：

```json
{
  "loopagent.pythonPath": "/usr/bin/python3"
}
```

如果不配置，扩展会使用系统 PATH 中的 `python`。

---

## 性能指标

### 图片分析速度

| 硬件配置 | 分析耗时 | 备注 |
|---------|---------|------|
| **CPU（Intel i7）** | 1-3 秒 | 首次启动需加载模型（5-10秒） |
| **GPU（NVIDIA RTX 3060）** | 150-500ms | 显著提速，推荐使用 |
| **Apple M1/M2** | 500ms-1s | MPS 加速支持 |

### 图片大小限制

- **最大文件大小**：5MB
- **最大分辨率**：1920×1080
- **超出自动缩放**：保持宽高比压缩

### 并发处理

- **多张图片**：并发分析，总耗时 ≈ 最慢一张的时间
- **并发限制**：最多同时处理 3 张图片（避免内存溢出）

---

## 错误处理

### 常见问题

#### 1. Python 模型服务未启动

**症状**：上传图片后无响应

**解决方案**：
```bash
# 手动测试 Python 环境
python --version

# 安装依赖
pip install torch transformers pillow fastapi uvicorn
```

#### 2. 模型下载失败

**症状**：首次运行卡在 "Downloading model..."

**解决方案**：
```bash
# 手动预下载模型
python scripts/download_model.py
```

#### 3. GPU 不可用

**症状**：分析速度慢（>2秒/张）

**解决方案**：
- 检查 CUDA/MPS 安装
- 视觉模型会自动降级到 CPU
- CPU 模式仍可正常工作，只是速度较慢

---

## 最佳实践

### ✅ 推荐做法

1. **上传清晰的截图**
   - 分辨率至少 800×600
   - 避免模糊或压缩过度的图片

2. **明确描述需求**
   - ❌ "分析这个"
   - ✅ "帮我实现这个登录页面的布局和样式"

3. **一次上传相关图片**
   - 可同时上传多张（设计稿 + 错误截图）
   - 视觉模型会并发分析

4. **利用上下文对话**
   - 第一轮：上传图片 + 初步实现
   - 第二轮："调整按钮颜色为蓝色"
   - 图片分析结果会保留在对话上下文中

### ❌ 避免做法

1. **上传无关图片**
   - 视觉分析会消耗时间和资源
   - 仅上传与任务相关的图片

2. **上传超大图片**
   - 会自动缩放，但会增加处理时间
   - 建议提前压缩到合理大小

3. **期望 100% 准确识别**
   - 视觉模型是辅助工具，不是 OCR 替代品
   - 复杂的手绘草图可能需要用户补充说明

---

## 与纯文本验证的对比

| 功能 | 视觉分析 | 纯文本验证 |
|------|---------|-----------|
| **设计稿转代码** | ✅ 核心价值 | ❌ 无法实现 |
| **错误截图诊断** | ✅ 高价值 | ⚠️ 需用户复制粘贴错误信息 |
| **代码错误检测** | ❌ 不可靠（24%） | ✅ 100% 可靠（tsc, eslint） |
| **UI 布局验证** | ✅ 唯一方案 | ❌ 无法实现 |

**结论**：
- ✅ **保留**：设计稿转代码、错误截图诊断、UI 预览
- ❌ **移除**：代码错误检测（应使用 tsc/eslint）

---

## 未来改进方向

### 短期（1-2 个月）

- [ ] 支持更多视觉模型（Florence-2、CLIP）
- [ ] 优化模型加载速度（预热机制）
- [ ] 增加图片标注功能（用户圈出重点区域）

### 中期（3-6 个月）

- [ ] 支持视频截图分析（动画效果理解）
- [ ] 集成 OCR 专用模型（提升文字识别准确率）
- [ ] 多模态融合（图片 + 代码 + 文档）

### 长期（6-12 个月）

- [ ] 实时屏幕监控（自动检测 UI 变化）
- [ ] 跨平台设计稿支持（Figma、Sketch API 集成）
- [ ] 生成式 UI（AI 直接生成设计稿）

---

## 相关文档

- [视觉模型 API 文档](../src/extension/vision/types.ts)
- [图片分析服务实现](../src/extension/vision/imageAnalysisService.ts)
- [本地视觉服务](../src/extension/vision/localVisionService.ts)
- [Python 视觉服务器](../python/vision_server.py)

---

## 常见问题 FAQ

### Q: 视觉功能是否需要联网？

A: 不需要。Moondream2 是完全本地运行的模型，不会上传任何图片到云端。

### Q: 模型文件存储在哪里？

A: 默认存储在用户主目录的 `.cache/huggingface/` 下（约 1.6GB）。

### Q: 是否支持中文图片识别？

A: 支持。Moondream2 对中文界面有良好的理解能力，但 OCR 识别中文准确率较低。

### Q: 如何卸载视觉功能？

A: 删除 Python 依赖和模型文件：
```bash
pip uninstall torch transformers
rm -rf ~/.cache/huggingface/hub/models--vikhyatk--moondream2
```

### Q: 视觉功能会影响扩展性能吗？

A: 不会。视觉模型在独立的 Python 子进程中运行，不影响 VS Code 主进程。只有在上传图片时才会启动模型。

---

## 贡献指南

欢迎贡献视觉功能相关的改进！

**如何贡献**：
1. Fork 本仓库
2. 创建特性分支：`git checkout -b feature/vision-enhancement`
3. 提交更改：`git commit -m "feat: 添加 Florence-2 模型支持"`
4. 推送分支：`git push origin feature/vision-enhancement`
5. 创建 Pull Request

**重点改进方向**：
- 新增视觉模型支持
- 优化图片预处理算法
- 提升分析速度
- 增强错误处理

---

## 许可证

视觉功能使用的 Moondream2 模型遵循 Apache 2.0 许可证。
