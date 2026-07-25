@echo off
REM Windows 版本的构建脚本
REM 用法: scripts\build-vision-bundle.bat

echo 🚀 LoopAgent 视觉模型打包工具 (Windows)
echo ========================================
echo.

REM 配置
set MODEL_ID=vikhyatk/moondream2
set PROJECT_ROOT=%~dp0..
set OUTPUT_DIR=%PROJECT_ROOT%\dist
set MODEL_CACHE_DIR=%PROJECT_ROOT%\models\moondream2

cd /d "%PROJECT_ROOT%"

REM 步骤 1: 检查 Python
echo 📋 检查 Python 环境...
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Python 未安装，请从 https://python.org 下载
    exit /b 1
)

for /f "tokens=2" %%i in ('python --version 2^>^&1') do set PYTHON_VERSION=%%i
echo ✅ Python %PYTHON_VERSION%
echo.

REM 步骤 2: 安装构建依赖
echo 📦 安装构建依赖...
pip install -q pyinstaller pillow
echo ✅ 依赖安装完成
echo.

REM 步骤 3: 下载模型
if not exist "%MODEL_CACHE_DIR%" (
    echo 📥 下载 Moondream2 模型 ^(约 1.6GB^)...
    echo    这可能需要 5-10 分钟，请耐心等待...

    python -c "from transformers import AutoModelForCausalLM, AutoTokenizer; import os; cache_dir = '%MODEL_CACHE_DIR%'; os.makedirs(cache_dir, exist_ok=True); print('[1/2] 下载模型...'); model = AutoModelForCausalLM.from_pretrained('%MODEL_ID%', cache_dir=cache_dir, trust_remote_code=True); print('[2/2] 下载 tokenizer...'); tokenizer = AutoTokenizer.from_pretrained('%MODEL_ID%', cache_dir=cache_dir); print('✅ 模型下载完成')"

    echo ✅ 模型已缓存到 %MODEL_CACHE_DIR%
) else (
    echo ✅ 使用已缓存的模型: %MODEL_CACHE_DIR%
)
echo.

REM 步骤 4: 构建
echo 🔨 开始打包（这可能需要 5-10 分钟）...
pyinstaller python\vision_server_optimized.py ^
    --name vision_server ^
    --onedir ^
    --console ^
    --add-data "%MODEL_CACHE_DIR%;models/moondream2" ^
    --hidden-import transformers ^
    --hidden-import torch ^
    --hidden-import PIL ^
    --hidden-import fastapi ^
    --hidden-import uvicorn ^
    --hidden-import pydantic ^
    --exclude-module matplotlib ^
    --exclude-module scipy ^
    --exclude-module pandas ^
    --clean ^
    --distpath "%OUTPUT_DIR%" ^
    --workpath "%PROJECT_ROOT%\build"

REM 步骤 5: 验证
if exist "%OUTPUT_DIR%\vision_server\vision_server.exe" (
    echo.
    echo ✅ 构建成功！
    echo.
    echo 📦 输出目录: %OUTPUT_DIR%\vision_server\
    dir "%OUTPUT_DIR%\vision_server\vision_server.exe"
    echo.
    echo 🎯 可执行文件: %OUTPUT_DIR%\vision_server\vision_server.exe
    echo.
    echo ▶️  测试运行:
    echo    %OUTPUT_DIR%\vision_server\vision_server.exe --help
    echo.
    echo 🎉 完成！
) else (
    echo ❌ 构建失败: 找不到输出文件
    exit /b 1
)
