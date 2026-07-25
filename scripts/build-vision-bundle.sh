#!/bin/bash
# 构建视觉模型独立可执行文件
# 用法: ./scripts/build-vision-bundle.sh [platform]
# platform: windows | linux | macos | all (默认: 当前平台)

set -e

echo "🚀 LoopAgent 视觉模型打包工具"
echo "================================"

# 配置
MODEL_ID="vikhyatk/moondream2"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="$PROJECT_ROOT/dist"
MODEL_CACHE_DIR="$PROJECT_ROOT/models/moondream2"

# 检测平台
PLATFORM="${1:-current}"
if [ "$PLATFORM" = "current" ]; then
    case "$(uname -s)" in
        Linux*)     PLATFORM=linux;;
        Darwin*)    PLATFORM=macos;;
        MINGW*|MSYS*|CYGWIN*) PLATFORM=windows;;
        *)          echo "❌ 未知平台"; exit 1;;
    esac
fi

echo "🎯 目标平台: $PLATFORM"
echo ""

# 步骤 1: 检查 Python
echo "📋 检查 Python 环境..."
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 未安装"
    exit 1
fi

PYTHON_VERSION=$(python3 --version | cut -d' ' -f2)
echo "✅ Python $PYTHON_VERSION"
echo ""

# 步骤 2: 安装构建依赖
echo "📦 安装构建依赖..."
pip3 install -q pyinstaller pillow
echo "✅ 依赖安装完成"
echo ""

# 步骤 3: 下载模型（如果不存在）
if [ ! -d "$MODEL_CACHE_DIR" ]; then
    echo "📥 下载 Moondream2 模型 (约 1.6GB)..."
    echo "   这可能需要 5-10 分钟，请耐心等待..."

    python3 - <<EOF
from transformers import AutoModelForCausalLM, AutoTokenizer
import os

cache_dir = "$MODEL_CACHE_DIR"
os.makedirs(cache_dir, exist_ok=True)

print(f"[1/2] 下载模型到 {cache_dir}")
model = AutoModelForCausalLM.from_pretrained(
    "$MODEL_ID",
    cache_dir=cache_dir,
    trust_remote_code=True
)

print("[2/2] 下载 tokenizer")
tokenizer = AutoTokenizer.from_pretrained(
    "$MODEL_ID",
    cache_dir=cache_dir
)

print("✅ 模型下载完成")
EOF

    echo "✅ 模型已缓存到 $MODEL_CACHE_DIR"
else
    echo "✅ 使用已缓存的模型: $MODEL_CACHE_DIR"
fi
echo ""

# 步骤 4: 创建 PyInstaller spec 文件
echo "📝 生成构建配置..."
cat > "$PROJECT_ROOT/vision_server.spec" <<'SPEC_EOF'
# -*- mode: python ; coding: utf-8 -*-
import os
import sys
from pathlib import Path

project_root = os.path.abspath('.')
model_dir = os.path.join(project_root, 'models', 'moondream2')

# 收集模型文件
model_files = []
if os.path.exists(model_dir):
    for root, dirs, files in os.walk(model_dir):
        for file in files:
            src = os.path.join(root, file)
            dst = os.path.relpath(src, project_root)
            model_files.append((src, os.path.dirname(dst)))

a = Analysis(
    ['python/vision_server_optimized.py'],
    pathex=[project_root],
    binaries=[],
    datas=model_files,
    hiddenimports=[
        'transformers',
        'torch',
        'PIL',
        'fastapi',
        'uvicorn',
        'pydantic',
        'pydantic_core',
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
        'jupyter',
        'pytest',
        'sphinx',
        'tkinter',
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
    [],
    exclude_binaries=True,
    name='vision_server',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='vision_server',
)
SPEC_EOF

echo "✅ 配置已生成"
echo ""

# 步骤 5: 构建
echo "🔨 开始打包（这可能需要 5-10 分钟）..."
cd "$PROJECT_ROOT"

pyinstaller vision_server.spec --clean --distpath "$OUTPUT_DIR" --workpath "$PROJECT_ROOT/build"

# 步骤 6: 验证输出
BINARY_NAME="vision_server"
if [ "$PLATFORM" = "windows" ]; then
    BINARY_NAME="vision_server.exe"
fi

BINARY_PATH="$OUTPUT_DIR/vision_server/$BINARY_NAME"

if [ -f "$BINARY_PATH" ]; then
    echo ""
    echo "✅ 构建成功！"
    echo ""
    echo "📦 输出文件:"
    ls -lh "$OUTPUT_DIR/vision_server/"
    echo ""

    # 计算总大小
    TOTAL_SIZE=$(du -sh "$OUTPUT_DIR/vision_server" | cut -f1)
    echo "📊 总大小: $TOTAL_SIZE"
    echo ""
    echo "🎯 可执行文件: $BINARY_PATH"
    echo ""
    echo "▶️  测试运行:"
    echo "   $BINARY_PATH --help"
    echo ""
else
    echo "❌ 构建失败: 找不到输出文件"
    exit 1
fi

echo "🎉 完成！"
