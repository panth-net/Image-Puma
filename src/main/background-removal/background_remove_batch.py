#!/usr/bin/env python3
"""One-shot RMBG-2.0 batch runner for Image Puma.

Reads a JSON job from stdin and writes JSON-line progress events to stdout.
This intentionally does not launch Gradio or any long-running sidecar server.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

# RMBG-2.0 uses deform_conv2d, which Torch does not currently implement on
# Apple MPS. Keep the rest of the model on the GPU and fall back for that op.
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

REQUIRED_MODEL_FILES = (
    "config.json",
    "model.safetensors",
    "birefnet.py",
    "BiRefNet_config.py",
)


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def parse_positive_int(value: Any) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return 0
    return max(0, parsed)


def unique_output_path(path: Path, overwrite: bool) -> Path:
    if overwrite or not path.exists():
        return path

    stem = path.stem
    suffix = path.suffix
    parent = path.parent
    for index in range(1, 10_000):
        candidate = parent / f"{stem}-{index}{suffix}"
        if not candidate.exists():
            return candidate

    raise RuntimeError(f"Could not reserve a unique output path for {path}")


def write_image_atomic(image: Any, output_path: Path, image_format: str, **save_kwargs: Any) -> int:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = output_path.with_name(
        f".{output_path.stem}.{os.getpid()}.{next_temp_token()}.tmp{output_path.suffix}"
    )
    try:
        image.save(temp_path, format=image_format, **save_kwargs)
        os.replace(temp_path, output_path)
        return output_path.stat().st_size
    finally:
        try:
            temp_path.unlink(missing_ok=True)
        except TypeError:
            if temp_path.exists():
                temp_path.unlink()


_TEMP_TOKEN = 0


def next_temp_token() -> int:
    global _TEMP_TOKEN
    _TEMP_TOKEN += 1
    return _TEMP_TOKEN


def resize_image_if_needed(image: Any, max_width: int, max_height: int, resample: Any) -> Any:
    if max_width <= 0 and max_height <= 0:
        return image

    width, height = image.size
    aspect_ratio = width / height

    if max_width > 0 and max_height > 0:
        if width / max_width > height / max_height:
            next_width = max_width
            next_height = int(max_width / aspect_ratio)
        else:
            next_height = max_height
            next_width = int(max_height * aspect_ratio)
    elif max_width > 0:
        if width <= max_width:
            return image
        next_width = max_width
        next_height = int(max_width / aspect_ratio)
    else:
        if height <= max_height:
            return image
        next_height = max_height
        next_width = int(max_height * aspect_ratio)

    return image.resize((max(1, next_width), max(1, next_height)), resample)


def resolve_model_path() -> Path:
    configured_path = os.environ.get("IMAGE_PUMA_BACKGROUND_MODEL_DIR", "").strip()
    if configured_path:
        model_path = Path(configured_path).expanduser().resolve()
    elif getattr(sys, "frozen", False):
        model_path = Path(sys.executable).resolve().parent / "model"
    else:
        model_path = Path(__file__).resolve().parent / "model"

    missing_files = [
        filename
        for filename in REQUIRED_MODEL_FILES
        if not (model_path / filename).is_file()
    ]
    if missing_files:
        raise RuntimeError(
            "The bundled RMBG-2.0 model is incomplete. Missing: "
            f"{', '.join(missing_files)} in {model_path}"
        )
    return model_path


def load_runtime() -> tuple[Any, Any, Any, Any, str, Any]:
    try:
        import numpy as np
        import torch
        from PIL import Image
        from torchvision import transforms
        from transformers import AutoModelForImageSegmentation
    except Exception as exc:
        raise RuntimeError(
            "The bundled background remover runtime is incomplete. Missing import: "
            f"{exc}"
        ) from exc

    if hasattr(torch, "set_float32_matmul_precision"):
        torch.set_float32_matmul_precision("high")

    device = "cuda" if torch.cuda.is_available() else (
        "mps"
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available()
        else "cpu"
    )
    model_dtype = torch.float16 if device == "cuda" else torch.float32

    emit({
        "type": "model-loading",
        "device": device,
        "message": "Loading RMBG-2.0 model",
    })

    model_path = resolve_model_path()
    model = AutoModelForImageSegmentation.from_pretrained(
        str(model_path),
        local_files_only=True,
        trust_remote_code=True,
        torch_dtype=model_dtype,
    ).to(device)
    model.eval()

    transform = transforms.Compose([
        transforms.Resize((1024, 1024)),
        transforms.ToTensor(),
        transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
    ])

    emit({
        "type": "ready",
        "device": device,
        "message": f"Model ready on {device}",
    })

    return np, torch, Image, transform, device, model


def predict_mask(
    image_rgb: Any,
    np: Any,
    torch: Any,
    image_module: Any,
    transform: Any,
    device: str,
    model: Any,
) -> Any:
    model_dtype = torch.float16 if device == "cuda" else torch.float32
    inp = transform(image_rgb).unsqueeze(0).to(device=device, dtype=model_dtype)

    with torch.inference_mode():
        pred = model(inp)[-1].sigmoid().detach().cpu()

    pred_2d = pred[0].squeeze().numpy()
    low = 0.5 - 0.1 / 2
    high = 0.5 + 0.1 / 2
    pred_2d = np.clip((pred_2d - low) / (high - low), 0, 1)

    mask_1024 = image_module.fromarray((pred_2d * 255).astype("uint8"), mode="L")
    resampling = getattr(image_module, "Resampling", image_module)
    return mask_1024.resize(image_rgb.size, resampling.BILINEAR)


def apply_alpha(image_rgb: Any, mask_l: Any) -> Any:
    rgba = image_rgb.convert("RGBA")
    rgba.putalpha(mask_l.convert("L"))
    return rgba


def output_folder_for(source_path: Path, settings: dict[str, Any]) -> Path:
    if settings.get("destination") == "custom":
        custom_path = str(settings.get("customPath") or "").strip()
        if not custom_path:
            raise RuntimeError("Choose a custom output folder before running background removal.")
        return Path(custom_path)

    folder_name = str(settings.get("outputFolderName") or "background-removed").strip()
    return source_path.parent / (folder_name or "background-removed")


def resolve_requested_outputs(
    source_path: Path,
    file_info: dict[str, Any],
    settings: dict[str, Any],
) -> list[tuple[Path, str]]:
    explicit_output_path = str(file_info.get("outputPath") or "").strip()
    if explicit_output_path:
        output_path = Path(explicit_output_path)
        requested_format = str(file_info.get("outputFormat") or output_path.suffix.replace(".", "")).lower()
        if requested_format == "jpg":
            requested_format = "jpeg"
        if requested_format not in ("png", "webp"):
            raise RuntimeError("Background removal exports must be PNG or WebP.")
        return [(output_path, requested_format)]

    output_format = settings.get("outputFormat") or "png"
    output_dir = output_folder_for(source_path, settings)
    stem = source_path.stem
    outputs: list[tuple[Path, str]] = []

    if output_format in ("png", "both"):
        outputs.append((output_dir / f"{stem}.png", "png"))

    if output_format in ("webp", "both"):
        outputs.append((output_dir / f"{stem}.webp", "webp"))

    return outputs


def process_one(
    file_info: dict[str, Any],
    settings: dict[str, Any],
    runtime: tuple[Any, Any, Any, Any, str, Any],
) -> dict[str, Any]:
    np, torch, image_module, transform, device, model = runtime
    source_path = Path(file_info["sourcePath"])
    original_size = source_path.stat().st_size
    max_width = parse_positive_int(settings.get("maxWidth"))
    max_height = parse_positive_int(settings.get("maxHeight"))
    quality = min(100, max(1, parse_positive_int(settings.get("webpQuality")) or 100))
    overwrite = bool(settings.get("overwrite"))
    resampling = getattr(image_module, "Resampling", image_module)

    img = image_module.open(source_path).convert("RGB")
    mask = predict_mask(img, np, torch, image_module, transform, device, model)
    cutout = apply_alpha(img, mask)
    cutout = resize_image_if_needed(cutout, max_width, max_height, resampling.LANCZOS)

    outputs: list[dict[str, Any]] = []
    total_output_size = 0

    for requested_path, requested_format in resolve_requested_outputs(source_path, file_info, settings):
        output_path = unique_output_path(requested_path, overwrite)
        if requested_format == "png":
            output_size = write_image_atomic(cutout, output_path, "PNG")
        elif requested_format == "webp":
            output_size = write_image_atomic(cutout, output_path, "WEBP", quality=quality, method=6)
        else:
            raise RuntimeError("Background removal exports must be PNG or WebP.")

        total_output_size += output_size
        outputs.append({
            "outputPath": str(output_path),
            "outputSize": output_size,
            "width": cutout.width,
            "height": cutout.height,
        })

    return {
        "sourcePath": str(source_path),
        "outputPath": outputs[0]["outputPath"] if outputs else "",
        "originalSize": original_size,
        "outputSize": total_output_size,
        "success": True,
        "generatedOutputs": outputs,
    }


def main() -> int:
    if "--self-test" in sys.argv:
        try:
            import numpy
            import torch
            import torchvision
            import kornia
            import timm
            import transformers
            from PIL import Image

            resolve_model_path()
            del numpy, torch, torchvision, kornia, timm, transformers, Image
            emit({"type": "self-test", "ok": True})
            return 0
        except Exception as exc:
            emit({"type": "fatal-error", "message": str(exc)})
            return 4

    try:
        job = json.load(sys.stdin)
    except Exception as exc:
        emit({"type": "fatal-error", "message": f"Could not read job JSON: {exc}"})
        return 2

    files = job.get("files") or []
    settings = job.get("settings") or {}

    try:
        runtime = load_runtime()
    except Exception as exc:
        emit({"type": "fatal-error", "message": str(exc)})
        return 3

    results: list[dict[str, Any]] = []
    total = len(files)

    for index, file_info in enumerate(files):
        source_path = str(file_info.get("sourcePath") or "")
        display_name = str(file_info.get("fileName") or Path(source_path).stem)
        extension = str(file_info.get("extension") or Path(source_path).suffix)
        emit({
            "type": "file-started",
            "sourcePath": source_path,
            "displayName": f"{display_name}{extension}",
            "index": index,
            "total": total,
        })

        try:
            result = process_one(file_info, settings, runtime)
        except Exception as exc:
            result = {
                "sourcePath": source_path,
                "outputPath": "",
                "originalSize": int(file_info.get("fileSize") or 0),
                "outputSize": 0,
                "success": False,
                "error": str(exc),
            }

        results.append(result)
        emit({
            "type": "file-completed",
            "sourcePath": source_path,
            "displayName": f"{display_name}{extension}",
            "index": index,
            "total": total,
            "result": result,
        })

    emit({"type": "completed", "results": results})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
