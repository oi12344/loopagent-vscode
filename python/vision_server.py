#!/usr/bin/env python3
"""
轻量级视觉模型服务器 - Moondream2 集成
为 VSCode 扩展提供本地图像理解能力
"""
import asyncio
import base64
import json
import sys
import time
from pathlib import Path
from typing import Dict, Any, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import uvicorn

# 全局模型实例（延迟加载）
_model = None
_model_loaded = False


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
        # 动态导入以避免启动时阻塞
        from transformers import AutoModelForCausalLM, AutoTokenizer
        from PIL import Image
        import torch

        print("[Vision] Loading Moondream2 model...", file=sys.stderr)
        model_id = "vikhyatk/moondream2"

        # CPU 模式加载（优化内存占用）
        _model = {
            "model": AutoModelForCausalLM.from_pretrained(
                model_id,
                trust_remote_code=True,
                torch_dtype=torch.float32,  # CPU 使用 float32
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


@app.get("/health")
async def health_check():
    """健康检查端点"""
    return {
        "status": "healthy",
        "model_loaded": _model_loaded,
        "provider": "moondream2"
    }


@app.post("/analyze", response_model=AnalysisResponse)
async def analyze_image(request: AnalysisRequest):
    """分析图片端点"""
    start_time = time.time()

    try:
        # 加载模型（首次调用时）
        model_dict = load_model()
        model = model_dict["model"]
        tokenizer = model_dict["tokenizer"]

        # 加载图片
        from PIL import Image

        if request.image_path:
            image = Image.open(request.image_path).convert("RGB")
        elif request.image_base64:
            import io
            image_data = base64.b64decode(request.image_base64)
            image = Image.open(io.BytesIO(image_data)).convert("RGB")
        else:
            raise HTTPException(status_code=400, detail="Either image_path or image_base64 required")

        # 执行推理
        enc_image = model.encode_image(image)
        response_text = model.answer_question(enc_image, request.prompt, tokenizer)

        processing_time = int((time.time() - start_time) * 1000)

        return AnalysisResponse(
            text=response_text,
            data=None,
            confidence=None,
            processing_time_ms=processing_time
        )

    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Image file not found")
    except Exception as e:
        print(f"[Vision] Analysis error: {e}", file=sys.stderr)
        raise HTTPException(status_code=500, detail=f"Analysis failed: {str(e)}")


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
    args = parser.parse_args()

    print(f"[Vision] Starting server on {args.host}:{args.port}", file=sys.stderr)

    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        log_level="warning",  # 减少日志噪音
        access_log=False
    )
