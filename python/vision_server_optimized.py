#!/usr/bin/env python3
"""
轻量级视觉模型服务器 - Moondream2 集成（优化版）
包含图片大小保护、超时控制、并发限制
"""
import asyncio
import base64
import json
import os
import sys
import time
import threading
from pathlib import Path
from typing import Dict, Any, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import uvicorn
from PIL import Image

# ========== 配置参数 ==========
MAX_FILE_SIZE = 5 * 1024 * 1024  # 5MB
MAX_IMAGE_SIZE = (1920, 1080)     # FHD
INFERENCE_TIMEOUT = 30            # 30秒
MAX_CONCURRENT_REQUESTS = 2       # 最大并发数

# 全局模型实例（延迟加载）
_model = None
_model_loaded = False
_current_requests = 0
_request_lock = asyncio.Lock()


class AnalysisRequest(BaseModel):
    """视觉分析请求"""
    image_path: Optional[str] = None
    image_base64: Optional[str] = None
    prompt: str = "Describe this image in detail."
    output_format: str = "text"


class AnalysisResponse(BaseModel):
    """视觉分析响应"""
    text: str
    data: Optional[Dict[str, Any]] = None
    confidence: Optional[float] = None
    processing_time_ms: int


app = FastAPI(title="LoopAgent Vision Service")


def load_model():
    """延迟加载 Moondream2 模型"""
    global _model, _model_loaded

    if _model_loaded:
        return _model

    try:
        from transformers import AutoModelForCausalLM, AutoTokenizer
        import torch

        print("[Vision] Loading Moondream2 model...", file=sys.stderr)
        model_id = "vikhyatk/moondream2"

        _model = {
            "model": AutoModelForCausalLM.from_pretrained(
                model_id,
                trust_remote_code=True,
                torch_dtype=torch.float32,
                low_cpu_mem_usage=True
            ),
            "tokenizer": AutoTokenizer.from_pretrained(model_id)
        }

        _model_loaded = True
        print("[Vision] Model loaded successfully", file=sys.stderr)
        return _model

    except Exception as e:
        print(f"[Vision] Failed to load model: {e}", file=sys.stderr)
        raise HTTPException(status_code=500, detail=f"Model loading failed: {str(e)}")


def resize_image_if_needed(image: Image.Image, max_size: tuple) -> Image.Image:
    """
    如果图片超过最大尺寸，按比例缩小
    保持宽高比，使用高质量重采样
    """
    width, height = image.size
    max_width, max_height = max_size

    if width <= max_width and height <= max_height:
        return image

    ratio = min(max_width / width, max_height / height)
    new_width = int(width * ratio)
    new_height = int(height * ratio)

    print(f"[Vision] Resizing image: {width}×{height} → {new_width}×{new_height}", file=sys.stderr)

    return image.resize((new_width, new_height), Image.Resampling.LANCZOS)


class TimeoutException(Exception):
    pass


def run_with_timeout(func, args=(), kwargs=None, timeout_seconds=30):
    """跨平台超时执行（使用线程）"""
    if kwargs is None:
        kwargs = {}

    result = [TimeoutException(f"Timeout after {timeout_seconds}s")]

    def target():
        try:
            result[0] = func(*args, **kwargs)
        except Exception as e:
            result[0] = e

    thread = threading.Thread(target=target)
    thread.daemon = True
    thread.start()
    thread.join(timeout_seconds)

    if thread.is_alive():
        raise TimeoutException(f"Inference timeout after {timeout_seconds}s (image too large?)")

    if isinstance(result[0], Exception):
        raise result[0]

    return result[0]


@app.get("/health")
async def health_check():
    """健康检查端点"""
    return {
        "status": "healthy",
        "model_loaded": _model_loaded,
        "provider": "moondream2",
        "max_image_size": MAX_IMAGE_SIZE,
        "max_file_size_mb": MAX_FILE_SIZE / 1024 / 1024
    }


@app.post("/analyze", response_model=AnalysisResponse)
async def analyze_image(request: AnalysisRequest):
    """分析图片端点（带保护）"""
    global _current_requests

    # ===== 1. 并发限制 =====
    async with _request_lock:
        if _current_requests >= MAX_CONCURRENT_REQUESTS:
            raise HTTPException(
                status_code=429,
                detail=f"Too many concurrent requests (max {MAX_CONCURRENT_REQUESTS})"
            )
        _current_requests += 1

    start_time = time.time()

    try:
        # ===== 2. 加载图片并检查大小 =====
        if request.image_path:
            # 检查文件大小
            if not os.path.exists(request.image_path):
                raise HTTPException(status_code=404, detail="Image file not found")

            file_size = os.path.getsize(request.image_path)
            if file_size > MAX_FILE_SIZE:
                raise HTTPException(
                    status_code=413,
                    detail=f"Image too large: {file_size / 1024 / 1024:.1f}MB (max {MAX_FILE_SIZE / 1024 / 1024:.0f}MB)"
                )

            image = Image.open(request.image_path).convert("RGB")

        elif request.image_base64:
            image_data = base64.b64decode(request.image_base64)
            if len(image_data) > MAX_FILE_SIZE:
                raise HTTPException(
                    status_code=413,
                    detail=f"Image data too large (max {MAX_FILE_SIZE / 1024 / 1024:.0f}MB)"
                )

            import io
            image = Image.open(io.BytesIO(image_data)).convert("RGB")
        else:
            raise HTTPException(status_code=400, detail="Either image_path or image_base64 required")

        # ===== 3. 自动缩放大图 =====
        original_size = image.size
        image = resize_image_if_needed(image, MAX_IMAGE_SIZE)
        if image.size != original_size:
            print(f"[Vision] Resized from {original_size} to {image.size}", file=sys.stderr)

        # ===== 4. 加载模型 =====
        model_dict = load_model()
        model = model_dict["model"]
        tokenizer = model_dict["tokenizer"]

        # ===== 5. 执行推理（带超时保护）=====
        def inference():
            enc_image = model.encode_image(image)
            return model.answer_question(enc_image, request.prompt, tokenizer)

        response_text = run_with_timeout(inference, timeout_seconds=INFERENCE_TIMEOUT)

        processing_time = int((time.time() - start_time) * 1000)

        return AnalysisResponse(
            text=response_text,
            data=None,
            confidence=None,
            processing_time_ms=processing_time
        )

    except TimeoutException as e:
        raise HTTPException(status_code=504, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        print(f"[Vision] Analysis error: {e}", file=sys.stderr)
        raise HTTPException(status_code=500, detail=f"Analysis failed: {str(e)}")
    finally:
        # 释放并发槽位
        async with _request_lock:
            _current_requests -= 1


@app.on_event("shutdown")
async def shutdown_event():
    """清理资源"""
    global _model, _model_loaded
    if _model:
        print("[Vision] Shutting down model...", file=sys.stderr)
        _model = None
        _model_loaded = False


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Vision model server")
    parser.add_argument("--port", type=int, default=8765, help="Server port")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Server host")
    parser.add_argument("--max-size", type=int, default=1920, help="Max image width")
    args = parser.parse_args()

    # 动态调整配置
    if args.max_size:
        MAX_IMAGE_SIZE = (args.max_size, int(args.max_size * 9 / 16))

    print(f"[Vision] Starting server on {args.host}:{args.port}", file=sys.stderr)
    print(f"[Vision] Max image size: {MAX_IMAGE_SIZE}", file=sys.stderr)
    print(f"[Vision] Max file size: {MAX_FILE_SIZE / 1024 / 1024:.0f}MB", file=sys.stderr)

    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        log_level="warning",
        access_log=False
    )
