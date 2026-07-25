# 视觉模型打包集成指南

## 🎯 目标

将 Moondream2 模型（1.6GB）和 Python 运行时直接打包进 VSIX，实现：
- ✅ 用户安装扩展后立即可用
- ✅ 无需安装 Python
- ✅ 无需下载模型
- ✅ 完全离线运行

---

## 📦 方案选择

### 方案 A：PyInstaller 打包（推荐）⭐

**原理**：将 Python + 依赖 + 模型打包成独立可执行文件

**优点**：
- ✅ 单文件分发，简单
- ✅ 用户无需 Python 环境
- ✅ 支持 Windows/Linux/macOS

**缺点**：
- ⚠️ VSIX 体积 ~2GB
- ⚠️ 需要为每个平台单独构建

---

### 方案 B：嵌入式 Python（备选）

**原理**：打包 Python 嵌入版 + 依赖库 + 模型

**优点**：
- ✅ 更小的体积（~1.8GB）
- ✅ 可动态加载模型

**缺点**：
- ⚠️ 需要复杂的依赖管理
- ⚠️ 路径配置复杂

---

## 🚀 实现方案 A（PyInstaller）

### 步骤 1：准备构建脚本

创建 `scripts/build-vision-bundle.sh`：

\`\`\`bash
#!/bin/bash
set -e

echo "🚀 开始构建视觉模型独立包..."

# 配置
MODEL_ID="vikhyatk/moondream2"
OUTPUT_DIR="dist"
BUNDLE_NAME="vision_server"

# 1. 安装依赖
echo "📦 安装构建依赖..."
pip install pyinstaller transformers torch pillow

# 2. 预下载模型到本地
echo "📥 下载 Moondream2 模型..."
python - <<EOF
from transformers import AutoModelForCausalLM, AutoTokenizer
import os

# 下载到项目目录
cache_dir = os.path.abspath("models/moondream2")
os.makedirs(cache_dir, exist_ok=True)

print(f"Downloading model to {cache_dir}")
model = AutoModelForCausalLM.from_pretrained(
    "$MODEL_ID",
    cache_dir=cache_dir,
    trust_remote_code=True
)
tokenizer = AutoTokenizer.from_pretrained(
    "$MODEL_ID",
    cache_dir=cache_dir
)
print("✅ Model downloaded")
EOF

# 3. 创建 PyInstaller spec 文件
echo "📝 创建构建配置..."
cat > vision_server.spec <<'SPEC_EOF'
# -*- mode: python ; coding: utf-8 -*-
import os
import sys
from pathlib import Path

# 项目根目录
project_root = os.path.abspath('.')

# 模型目录
model_dir = os.path.join(project_root, 'models', 'moondream2')

# 收集模型文件
model_files = []
for root, dirs, files in os.walk(model_dir):
    for file in files:
        src = os.path.join(root, file)
        dst = os.path.relpath(src, project_root)
        model_files.append((src, os.path.dirname(dst)))

a = Analysis(
    ['python/vision_server.py'],
    pathex=[project_root],
    binaries=[],
    datas=model_files,  # 打包模型文件
    hiddenimports=[
        'transformers',
        'torch',
        'PIL',
        'fastapi',
        'uvicorn',
        'pydantic',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'matplotlib',
        'scipy',
        'pandas',
        'notebook',
        'IPython',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=None,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=None)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='vision_server',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
SPEC_EOF

# 4. 构建可执行文件
echo "🔨 开始打包..."
pyinstaller vision_server.spec --clean

# 5. 验证输出
if [ -f "dist/vision_server" ] || [ -f "dist/vision_server.exe" ]; then
    echo "✅ 构建成功！"
    ls -lh dist/vision_server*
else
    echo "❌ 构建失败"
    exit 1
fi

echo ""
echo "📦 打包完成！"
echo "输出文件: dist/vision_server*"
echo "大小约: ~200MB (可执行文件) + 1.6GB (模型)"
\`\`\`

### 步骤 2：多平台构建

创建 `scripts/build-all-platforms.yml`（GitHub Actions）：

\`\`\`yaml
name: Build Vision Bundle

on:
  push:
    tags:
      - 'v*'

jobs:
  build:
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
        include:
          - os: ubuntu-latest
            output: vision_server
            platform: linux
          - os: windows-latest
            output: vision_server.exe
            platform: win32
          - os: macos-latest
            output: vision_server
            platform: darwin

    runs-on: \${{ matrix.os }}

    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Python
        uses: actions/setup-python@v4
        with:
          python-version: '3.10'
      
      - name: Install dependencies
        run: |
          pip install pyinstaller
          pip install -r python/requirements.txt
      
      - name: Download model
        run: |
          python scripts/download_model.py
      
      - name: Build bundle
        run: |
          pyinstaller vision_server.spec --clean
      
      - name: Upload artifact
        uses: actions/upload-artifact@v3
        with:
          name: vision_server-\${{ matrix.platform }}
          path: dist/\${{ matrix.output }}
\`\`\`

### 步骤 3：修改扩展启动逻辑

修改 `src/extension/vision/localVisionService.ts`：

\`\`\`typescript
export class LocalVisionService implements VisionProvider {
  // ... 现有代码

  private getExecutablePath(): string {
    const platform = process.platform;
    let binaryName: string;

    switch (platform) {
      case 'win32':
        binaryName = 'vision_server.exe';
        break;
      case 'darwin':
        binaryName = 'vision_server';
        break;
      case 'linux':
        binaryName = 'vision_server';
        break;
      default:
        throw new VisionServiceError(
          'python_process_failed',
          \`Unsupported platform: \${platform}\`
        );
    }

    // 打包后的二进制文件路径
    const bundledPath = path.join(this.extensionPath, 'bin', binaryName);
    
    if (fs.existsSync(bundledPath)) {
      console.log(\`[VisionService] Using bundled executable: \${bundledPath}\`);
      return bundledPath;
    }

    // 回退到 Python 脚本（开发模式）
    throw new VisionServiceError(
      'python_process_failed',
      'Vision server executable not found. Please install dependencies.'
    );
  }

  async start(): Promise<void> {
    if (this.pythonProcess) {
      throw new VisionServiceError('service_not_started', 'Service already started');
    }

    try {
      const executablePath = this.getExecutablePath();

      // ✅ 直接运行二进制文件（无需 Python）
      this.pythonProcess = spawn(
        executablePath,
        ['--port', String(this.port), '--host', this.host],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env },
        }
      );

      // ... 其余启动逻辑
    } catch (error) {
      throw new VisionServiceError(
        'python_process_failed',
        \`Failed to start vision service: \${error}\`
      );
    }
  }
}
\`\`\`

### 步骤 4：修改 package.json

\`\`\`json
{
  "name": "loopagent-vscode",
  "scripts": {
    "build:vision": "bash scripts/build-vision-bundle.sh",
    "package:full": "npm run build:vision && vsce package --out loopagent-full.vsix"
  },
  "files": [
    "bin/vision_server*",
    "models/**"
  ]
}
\`\`\`

### 步骤 5：构建完整包

\`\`\`bash
# 1. 构建视觉服务二进制
npm run build:vision

# 2. 检查输出
ls -lh dist/vision_server*
# vision_server (Linux/macOS): ~200MB
# vision_server.exe (Windows): ~180MB

# 3. 复制到扩展目录
mkdir -p bin
cp dist/vision_server* bin/

# 4. 打包 VSIX
npm run package:full

# 输出
# loopagent-full.vsix (~2.2GB)
\`\`\`

---

## 📊 打包后的目录结构

\`\`\`
loopagent-vscode/
├── bin/
│   ├── vision_server.exe       # Windows 二进制 (~180MB)
│   ├── vision_server-linux     # Linux 二进制 (~200MB)
│   └── vision_server-darwin    # macOS 二进制 (~200MB)
├── models/
│   └── moondream2/             # 模型文件 (~1.6GB)
│       ├── config.json
│       ├── model.safetensors
│       └── tokenizer.json
├── extension.js                # 编译后的扩展代码
└── package.json

打包后 VSIX 大小：
- 单平台版: ~1.8GB (仅包含当前平台二进制)
- 全平台版: ~2.2GB (包含所有平台二进制)
\`\`\`

---

## 🔧 优化技巧

### 1. 使用 UPX 压缩

\`\`\`bash
# 压缩二进制文件（减少 40-60%）
upx --best dist/vision_server*

# 压缩前: 200MB
# 压缩后: 80-120MB
\`\`\`

### 2. 排除不必要的库

\`\`\`python
# vision_server.spec 中添加
excludes=[
    'matplotlib',
    'scipy',
    'pandas',
    'notebook',
    'IPython',
    'jupyter',
    'pytest',
    'sphinx',
]
\`\`\`

### 3. 模型量化

\`\`\`python
# 使用 INT8 量化（减少 50% 模型大小）
from transformers import BitsAndBytesConfig

quantization_config = BitsAndBytesConfig(load_in_8bit=True)

model = AutoModelForCausalLM.from_pretrained(
    model_id,
    quantization_config=quantization_config
)

# 模型大小: 1.6GB → 800MB
\`\`\`

### 4. 按需下载模型

\`\`\`typescript
// 方案：二进制打包，模型按需下载
// VSIX 大小: 200MB (仅二进制)
// 首次启动时下载模型: 1.6GB

async start(): Promise<void> {
  const modelPath = path.join(this.extensionPath, 'models', 'moondream2');
  
  if (!fs.existsSync(modelPath)) {
    // 首次启动，提示下载
    const choice = await vscode.window.showInformationMessage(
      '视觉功能需要下载 1.6GB 模型，是否下载？',
      '下载',
      '取消'
    );
    
    if (choice === '下载') {
      await this.downloadModel();
    }
  }
  
  // 启动服务
  this.pythonProcess = spawn(this.executablePath, ...);
}
\`\`\`

---

## 📋 最终部署策略

### 策略 1：轻量版 + 完整版（推荐）⭐

**轻量版**（20MB）：
- 上传到 Marketplace
- 首次启动时自动安装依赖

**完整版**（2.2GB）：
- 放在 GitHub Release
- 适合离线/企业用户

**README 说明**：
\`\`\`markdown
## 安装

### 在线安装（推荐）
从 [VSCode Marketplace](https://marketplace.visualstudio.com/...) 安装。
首次启动会自动下载 AI 模型（约 4GB）。

### 离线安装（完整包）
下载 [完整安装包](https://github.com/.../releases/loopagent-full-2.2gb.vsix)。
无需联网，开箱即用。

\`\`\`bash
# 安装完整包
code --install-extension loopagent-full-2.2gb.vsix
\`\`\`
\`\`\`

---

### 策略 2：仅打包二进制，模型按需下载

**VSIX 大小**：200MB（可上传 Marketplace）

**首次启动流程**：
\`\`\`
用户安装扩展 (200MB)
    ↓
打开 VSCode
    ↓
弹窗："需要下载 1.6GB AI 模型？"
    ↓
点击"下载" → 后台下载（5-10 分钟）
    ↓
完成
\`\`\`

**优点**：
- ✅ VSIX 可上传 Marketplace
- ✅ 无需 Python 环境
- ✅ 用户可选择不下载

---

## ✨ Insight ─────────────────────────────────────
- **打包权衡**：完整打包（2GB，开箱即用）vs 按需下载（200MB，需等待）
- **分发策略**：Marketplace 轻量版 + GitHub Release 完整版，满足不同用户需求
- **构建自动化**：GitHub Actions 多平台构建，确保跨平台一致性
─────────────────────────────────────────────────

---

## 🎯 立即可做的事

我帮你创建完整的构建脚本：
