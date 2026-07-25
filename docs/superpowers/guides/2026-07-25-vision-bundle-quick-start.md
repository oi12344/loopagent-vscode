# 视觉模型打包 - 快速开始

## 🎯 目标

将 Moondream2 模型打包进 VSIX，实现开箱即用。

---

## 🚀 5 分钟快速构建

### Windows 用户

```cmd
# 1. 下载模型（首次运行，约 1.6GB）
python scripts\download_model.py

# 2. 打包成独立可执行文件（约 5-10 分钟）
scripts\build-vision-bundle.bat

# 3. 复制到扩展目录
node scripts\copy-binaries.js

# 4. 打包完整版 VSIX
npm run package:full

# 输出: dist/loopagent-full.vsix (~2GB)
```

### Linux/macOS 用户

```bash
# 1. 下载模型
python3 scripts/download_model.py

# 2. 打包
chmod +x scripts/build-vision-bundle.sh
./scripts/build-vision-bundle.sh

# 3. 复制到扩展目录
node scripts/copy-binaries.js

# 4. 打包完整版 VSIX
npm run package:full

# 输出: dist/loopagent-full.vsix (~2GB)
```

---

## 📦 构建产物

### 构建后的目录结构

```
loopagent-vscode/
├── dist/
│   ├── vision_server/          # PyInstaller 输出
│   │   ├── vision_server.exe   # Windows 可执行文件
│   │   ├── models/             # 打包的模型文件 (~1.6GB)
│   │   └── _internal/          # Python 运行时和依赖
│   └── loopagent-full.vsix     # 最终 VSIX 包 (~2GB)
├── bin/
│   └── vision_server/          # 复制后的二进制（用于打包）
└── models/
    └── moondream2/             # 原始模型缓存
```

### 文件大小

| 文件/目录 | 大小 | 说明 |
|---------|------|------|
| `dist/vision_server/` | ~1.8GB | 完整的独立包 |
| `dist/vision_server.exe` | ~150MB | 可执行文件本身 |
| `models/moondream2/` | ~1.6GB | 模型权重 |
| `_internal/` | ~50MB | Python 运行时 |
| **最终 VSIX** | **~2GB** | 压缩后的扩展包 |

---

## 🎯 两种分发策略

### 策略 A：双版本分发（推荐）⭐

#### 轻量版（VSCode Marketplace）
```bash
# 打包轻量版（不含模型）
npm run package:lite

# 输出: dist/loopagent-lite.vsix (~20MB)
# 上传到 Marketplace
```

**用户体验**：
- 从 Marketplace 安装（20MB，1 分钟）
- 首次启动弹窗："需要下载 4GB 依赖？"
- 点击安装 → 自动下载（10 分钟）

#### 完整版（GitHub Release）
```bash
# 打包完整版（含模型）
npm run package:full

# 输出: dist/loopagent-full.vsix (~2GB)
# 上传到 GitHub Release
```

**用户体验**：
- 下载 VSIX（2GB，慢速网络 30 分钟）
- 安装：`code --install-extension loopagent-full.vsix`
- 打开 VSCode → 直接可用 ✅

---

### 策略 B：仅完整版（企业内网）

适合无法联网的企业环境：

```bash
# 1. 构建完整包
npm run package:full

# 2. 分发给用户（内网网盘/U盘）
# 企业网盘: https://company-drive/loopagent-full.vsix

# 3. 用户安装
code --install-extension loopagent-full.vsix

# 完成！无需联网
```

---

## 🔧 自定义构建

### 修改模型分辨率限制

编辑 `python/vision_server_optimized.py`：

```python
# 默认配置
MAX_FILE_SIZE = 5 * 1024 * 1024    # 5MB
MAX_IMAGE_SIZE = (1920, 1080)      # FHD

# 低配机器
MAX_FILE_SIZE = 3 * 1024 * 1024    # 3MB
MAX_IMAGE_SIZE = (1280, 720)       # 720p

# 高配机器
MAX_FILE_SIZE = 10 * 1024 * 1024   # 10MB
MAX_IMAGE_SIZE = (2560, 1440)      # 2K
```

重新构建：
```bash
npm run build:vision
```

---

### 压缩可执行文件（减少 40-60%）

安装 UPX：
```bash
# Windows (Chocolatey)
choco install upx

# Linux
sudo apt install upx

# macOS
brew install upx
```

修改构建脚本：
```bash
# 构建后压缩
upx --best dist/vision_server/vision_server.exe

# 大小: 150MB → 60-80MB
```

---

### 使用量化模型（减少 50% 模型大小）

修改 `python/vision_server_optimized.py`：

```python
from transformers import BitsAndBytesConfig

def load_model():
    # 添加量化配置
    quantization_config = BitsAndBytesConfig(
        load_in_8bit=True,  # INT8 量化
    )

    model = AutoModelForCausalLM.from_pretrained(
        model_id,
        quantization_config=quantization_config,  # ✅ 启用量化
        trust_remote_code=True,
        low_cpu_mem_usage=True
    )
```

**效果**：
- 模型大小: 1.6GB → 800MB
- 推理速度: 略快（约 10%）
- 精度损失: <1%

重新构建：
```bash
python scripts/download_model.py  # 重新下载量化模型
npm run build:vision
```

---

## 🧪 测试打包结果

### 测试可执行文件

```bash
# Windows
dist\vision_server\vision_server.exe --help

# 启动服务
dist\vision_server\vision_server.exe --port 8765

# 健康检查
curl http://127.0.0.1:8765/health
```

### 测试 VSIX 安装

```bash
# 安装扩展
code --install-extension dist/loopagent-full.vsix

# 查看安装位置
# Windows: %USERPROFILE%\.vscode\extensions\loopagent-*
# Linux/macOS: ~/.vscode/extensions/loopagent-*

# 检查二进制文件
ls ~/.vscode/extensions/loopagent-*/bin/vision_server/

# 卸载
code --uninstall-extension loopagent-vscode
```

---

## 📊 构建时间预估

| 步骤 | 首次运行 | 后续运行 |
|------|---------|---------|
| 下载模型 | 5-10 分钟 | 跳过（缓存） |
| PyInstaller 打包 | 5-10 分钟 | 3-5 分钟 |
| 复制文件 | 30 秒 | 30 秒 |
| VSCE 打包 | 1-2 分钟 | 1-2 分钟 |
| **总计** | **12-23 分钟** | **5-8 分钟** |

---

## 🐛 常见问题

### Q1: PyInstaller 打包失败？

**错误**：`ModuleNotFoundError: No module named 'transformers'`

**解决**：
```bash
pip install transformers torch pillow fastapi uvicorn pydantic
```

---

### Q2: 打包后体积过大？

**当前大小**：2GB

**优化方案**：
1. ✅ 使用 UPX 压缩（减少 40%）→ 1.2GB
2. ✅ 模型量化（减少 50%）→ 1.2GB
3. ✅ 排除不必要的库 → 1.1GB
4. ✅ 组合使用 → **~800MB**

---

### Q3: 模型下载失败？

**错误**：`Connection timeout`

**解决**：使用国内镜像
```bash
# 设置环境变量
export HF_ENDPOINT=https://hf-mirror.com

# 重新下载
python scripts/download_model.py
```

---

### Q4: 启动时找不到模型文件？

**错误**：`Model not found: models/moondream2/config.json`

**原因**：PyInstaller 未正确打包模型文件

**解决**：检查 `vision_server.spec` 中的 `datas` 配置
```python
# 确保模型目录被包含
datas=[
    ('models/moondream2', 'models/moondream2'),
]
```

---

## ✨ Insight ─────────────────────────────────────
- **构建一次，到处运行**：PyInstaller 生成的可执行文件包含完整运行时，用户无需安装 Python
- **分层打包策略**：Marketplace 轻量版 + GitHub Release 完整版，覆盖在线/离线场景
- **自动化工具链**：npm scripts 串联所有步骤，一键构建发布
─────────────────────────────────────────────────

---

## 🎯 立即开始

```bash
# 一键构建完整包
npm run package:full

# 输出: dist/loopagent-full.vsix (~2GB)
# 安装: code --install-extension dist/loopagent-full.vsix
```

**现在你的扩展已经包含完整的视觉模型，开箱即用！** 🎉
