"""
预下载 Moondream2 模型到本地缓存
用于构建打包时包含模型文件
"""
import os
import sys
from pathlib import Path
from transformers import AutoModelForCausalLM, AutoTokenizer

# 配置
MODEL_ID = "vikhyatk/moondream2"
PROJECT_ROOT = Path(__file__).parent.parent
CACHE_DIR = PROJECT_ROOT / "models" / "moondream2"

def download_model():
    """下载模型到项目目录"""
    print(f"📥 下载 Moondream2 模型到: {CACHE_DIR}")
    print(f"   模型大小约 1.6GB，首次下载需要 5-10 分钟")
    print()

    # 创建缓存目录
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    try:
        # 下载模型
        print("[1/2] 下载模型权重...")
        model = AutoModelForCausalLM.from_pretrained(
            MODEL_ID,
            cache_dir=str(CACHE_DIR),
            trust_remote_code=True
        )
        print("✅ 模型下载完成")

        # 下载 tokenizer
        print("[2/2] 下载 tokenizer...")
        tokenizer = AutoTokenizer.from_pretrained(
            MODEL_ID,
            cache_dir=str(CACHE_DIR)
        )
        print("✅ Tokenizer 下载完成")

        # 统计文件大小
        total_size = sum(
            f.stat().st_size
            for f in CACHE_DIR.rglob('*')
            if f.is_file()
        )
        size_mb = total_size / (1024 * 1024)

        print()
        print(f"📊 下载完成!")
        print(f"   缓存目录: {CACHE_DIR}")
        print(f"   总大小: {size_mb:.1f} MB")
        print()

        return True

    except Exception as e:
        print(f"❌ 下载失败: {e}")
        return False

def check_model_exists():
    """检查模型是否已下载"""
    if not CACHE_DIR.exists():
        return False

    # 检查关键文件
    required_files = [
        "config.json",
        "tokenizer.json",
    ]

    for file in required_files:
        if not any(CACHE_DIR.rglob(file)):
            return False

    return True

if __name__ == "__main__":
    print("🚀 Moondream2 模型下载工具")
    print("=" * 50)
    print()

    # 检查是否已存在
    if check_model_exists():
        print(f"✅ 模型已存在: {CACHE_DIR}")
        print("   跳过下载")
        sys.exit(0)

    # 下载模型
    success = download_model()

    if success:
        print("🎉 模型下载成功！")
        print("   现在可以运行构建脚本:")
        print("   - Linux/macOS: ./scripts/build-vision-bundle.sh")
        print("   - Windows: scripts\\build-vision-bundle.bat")
        sys.exit(0)
    else:
        print("❌ 模型下载失败")
        sys.exit(1)
