# 视觉功能部署与使用指南

## ⚠️ 重要提示

**打包 VSIX 后，用户无法直接使用视觉功能**，因为：

1. ❌ Python 运行时不包含在扩展包中
2. ❌ Moondream2 模型（1.6GB）不包含在扩展包中
3. ❌ Python 依赖需要用户手动安装

## 📦 当前部署方案的限制

### VSIX 包只包含
```
loopagent-vscode.vsix
├── extension.js (编译后的 TypeScript)
├── python/
│   ├── vision_server.py ✅
│   └── requirements.txt ✅
├── package.json ✅
└── ... 其他静态资源
```

### 不包含（需要用户安装）
```
❌ Python 3.10+ 运行时
❌ pip 包管理器
❌ PyTorch (~2GB)
❌ Transformers + 依赖 (~500MB)
❌ Moondream2 模型 (~1.6GB)
```

**总计用户需额外下载：约 4GB**

---

## 🔄 三种部署方案对比

### 方案 1：用户手动安装（当前方案）✅

**优点**：
- ✅ 扩展包小（<50MB）
- ✅ 不增加 Marketplace 下载时间
- ✅ 用户可选择不安装（节省空间）

**缺点**：
- ❌ 安装步骤复杂（需运行命令）
- ❌ 首次下载模型耗时 5-10 分钟
- ❌ 依赖用户本地 Python 环境

**适用场景**：
- 开发者用户（熟悉命令行）
- 可选功能（不影响核心使用）

---

### 方案 2：扩展自动下载（推荐）⭐

**实现思路**：
```typescript
// 首次激活时检测 Python 依赖
async function ensureVisionDependencies(context: vscode.ExtensionContext) {
  const depsInstalled = context.globalState.get("visionDepsInstalled");
  
  if (!depsInstalled) {
    const choice = await vscode.window.showInformationMessage(
      "视觉功能需要下载约 4GB 的 AI 模型，是否现在安装？",
      "立即安装", "稍后提醒", "不再提示"
    );
    
    if (choice === "立即安装") {
      await installVisionDependencies(context);
    }
  }
}

async function installVisionDependencies(context: vscode.ExtensionContext) {
  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "正在安装视觉功能依赖...",
    cancellable: true
  }, async (progress, token) => {
    // 1. 检测 Python
    progress.report({ message: "检测 Python 环境..." });
    const pythonPath = await detectPython();
    
    // 2. 安装 pip 依赖
    progress.report({ message: "安装 Python 包 (1/2)...", increment: 30 });
    await execAsync(`${pythonPath} -m pip install -r ${requirementsPath}`);
    
    // 3. 预下载模型
    progress.report({ message: "下载 AI 模型 (2/2)...", increment: 40 });
    await preloadModel(pythonPath);
    
    // 4. 标记完成
    await context.globalState.update("visionDepsInstalled", true);
    progress.report({ message: "安装完成！", increment: 30 });
  });
}
```

**优点**：
- ✅ 用户体验好（点击即安装）
- ✅ 进度可视化
- ✅ 可取消/重试

**缺点**：
- ⚠️ 需要处理各种环境差异
- ⚠️ 网络问题可能导致失败

**实现工作量**：约 2-3 天

---

### 方案 3：捆绑 Python 运行时（最完整）

使用 **PyInstaller** 或 **Nuitka** 将 Python 打包成独立可执行文件：

```bash
# 构建独立可执行文件
pyinstaller --onefile \
  --add-data "models:models" \
  --hidden-import torch \
  python/vision_server.py

# 生成
dist/vision_server.exe  # Windows (~150MB)
dist/vision_server      # Linux/macOS (~180MB)
```

**VSIX 包结构**：
```
loopagent-vscode.vsix
├── extension.js
├── bin/
│   ├── vision_server.exe (Windows)
│   ├── vision_server-linux (Linux)
│   └── vision_server-darwin (macOS)
└── models/
    └── moondream2/ (~1.6GB)
```

**优点**：
- ✅ 零依赖（无需 Python）
- ✅ 开箱即用
- ✅ 版本锁定（避免兼容性问题）

**缺点**：
- ❌ VSIX 体积巨大（~2GB+）
- ❌ VSCode Marketplace 可能拒绝上架
- ❌ 多平台构建复杂

**实现工作量**：约 1-2 周

---

## 📋 用户安装清单（当前方案）

### Windows 用户

```powershell
# 1. 检查 Python 版本
python --version
# 需要：Python 3.10 或更高

# 2. 安装依赖
pip install -r %USERPROFILE%\.vscode\extensions\loopagent-*\python\requirements.txt

# 3. 验证安装
python %USERPROFILE%\.vscode\extensions\loopagent-*\python\vision_server.py
# 看到 "Model loaded successfully" 即成功
```

### macOS/Linux 用户

```bash
# 1. 检查 Python 版本
python3 --version
# 需要：Python 3.10 或更高

# 2. 安装依赖
pip3 install -r ~/.vscode/extensions/loopagent-*/python/requirements.txt

# 3. 验证安装
python3 ~/.vscode/extensions/loopagent-*/python/vision_server.py
# 看到 "Model loaded successfully" 即成功
```

---

## 🛠️ 扩展中的检测与提示

### 优雅降级实现

```typescript
// src/extension.ts
export async function activate(context: vscode.ExtensionContext) {
  // 尝试启动视觉服务
  let visionAvailable = false;
  
  try {
    const visionService = new LocalVisionService(context.extensionPath);
    await visionService.start();
    visionAvailable = true;
    
    // 注册视觉工具
    toolRegistry.register(createAnalyzeEditWithVisionTool(...));
    
  } catch (error) {
    console.warn("Vision service not available:", error);
    
    // 友好提示用户
    const choice = await vscode.window.showWarningMessage(
      "视觉代码分析功能未就绪，是否查看安装指南？",
      "查看指南",
      "稍后"
    );
    
    if (choice === "查看指南") {
      vscode.env.openExternal(vscode.Uri.parse(
        "https://github.com/your-repo/blob/main/docs/vision-quick-start.md"
      ));
    }
  }
  
  // 扩展核心功能继续运行（不依赖视觉）
  // ...
}
```

---

## 📊 各方案对比总结

| 方案 | VSIX 大小 | 用户操作 | 首次启动 | 维护成本 |
|------|----------|---------|---------|---------|
| **手动安装** | ~20MB | 复杂（命令行） | 5-10 分钟 | 低 |
| **自动下载** ⭐ | ~30MB | 简单（点击） | 5-10 分钟 | 中 |
| **捆绑运行时** | ~2GB | 零操作 | 即时 | 高 |

---

## 💡 最终建议

### 当前阶段（MVP）
✅ **使用方案 1**（手动安装）
- 适合开发者早期测试
- 文档已完整，用户可自助安装
- 快速验证功能价值

### 下一步优化（2-3 天内实现）
⭐ **升级到方案 2**（自动下载）
- 显著提升用户体验
- 保持扩展包轻量
- 实现难度适中

### 长期目标（按需）
🚀 **探索方案 3**（捆绑运行时）
- 仅在用户量大、反馈积极时考虑
- 需要 CI/CD 自动构建多平台包
- 可能需要单独分发渠道（不通过 Marketplace）

---

**总结**：打包部署后用户**不能直接使用**，需要额外安装 Python 依赖（约 4GB）。建议实现自动安装功能提升体验。
