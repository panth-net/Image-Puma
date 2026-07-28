#!/usr/bin/env python3
"""Build Image Puma's offline, self-contained background-removal sidecar."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Iterable

from huggingface_hub import snapshot_download

ROOT = Path(__file__).resolve().parent.parent
MODEL_REPO = "briaai/RMBG-2.0"
MODEL_FILES = (
    "config.json",
    "model.safetensors",
    "birefnet.py",
    "BiRefNet_config.py",
)
OPTIONAL_MODEL_FILES = (
    "LICENSE",
    "LICENSE.md",
    "README.md",
)
PACKAGE_NAMES = (
    "kornia",
    "numpy",
    "pillow",
    "safetensors",
    "timm",
    "torch",
    "torchvision",
    "transformers",
)
HF_CREDENTIAL_ENV_KEYS = (
    "HF_TOKEN",
    "HUGGING_FACE_HUB_TOKEN",
    "HUGGINGFACEHUB_API_TOKEN",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--work-root", required=True, type=Path)
    return parser.parse_args()


def validate_model(model_path: Path) -> Path:
    model_path = model_path.expanduser().resolve()
    missing = [name for name in MODEL_FILES if not (model_path / name).is_file()]
    if missing:
        raise RuntimeError(
            f"RMBG-2.0 model directory {model_path} is missing: {', '.join(missing)}"
        )
    return model_path


def resolve_model() -> Path:
    configured = os.environ.get("IMAGE_PUMA_RMBG_MODEL_DIR", "").strip()
    if configured:
        return validate_model(Path(configured))

    download_args = {
        "repo_id": MODEL_REPO,
        "allow_patterns": [*MODEL_FILES, *OPTIONAL_MODEL_FILES],
    }
    try:
        cached = snapshot_download(local_files_only=True, **download_args)
        return validate_model(Path(cached))
    except Exception:
        pass

    try:
        downloaded = snapshot_download(
            token=os.environ.get("HF_TOKEN") or None,
            **download_args,
        )
        return validate_model(Path(downloaded))
    except Exception as exc:
        raise RuntimeError(
            "Could not obtain the gated briaai/RMBG-2.0 model for packaging. "
            "Accept its Hugging Face terms, then set HF_TOKEN or "
            "IMAGE_PUMA_RMBG_MODEL_DIR to an already-downloaded snapshot."
        ) from exc


def run_pyinstaller(work_root: Path) -> Path:
    runner = ROOT / "src" / "main" / "background-removal" / "background_remove_batch.py"
    dist_path = work_root / "dist"
    work_path = work_root / "work"
    spec_path = work_root / "spec"
    shutil.rmtree(work_root, ignore_errors=True)
    dist_path.mkdir(parents=True)
    work_path.mkdir(parents=True)
    spec_path.mkdir(parents=True)

    command = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onedir",
        "--contents-directory",
        "_internal",
        "--name",
        "background_remove_batch",
        "--distpath",
        str(dist_path),
        "--workpath",
        str(work_path),
        "--specpath",
        str(spec_path),
        "--collect-all",
        "kornia",
        "--collect-all",
        "timm",
        "--collect-all",
        "transformers",
        "--copy-metadata",
        "safetensors",
        "--copy-metadata",
        "torch",
        "--copy-metadata",
        "torchvision",
        str(runner),
    ]
    clean_environment = os.environ.copy()
    for key in HF_CREDENTIAL_ENV_KEYS:
        clean_environment.pop(key, None)
    subprocess.run(command, cwd=ROOT, env=clean_environment, check=True)
    return dist_path / "background_remove_batch"


def copy_files(source: Path, destination: Path, filenames: Iterable[str]) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    for filename in filenames:
        source_path = source / filename
        if source_path.is_file():
            shutil.copy2(source_path, destination / filename, follow_symlinks=True)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_fingerprint(model_path: Path) -> str:
    digest = hashlib.sha256()
    inputs = (
        ROOT / "requirements-background-removal.txt",
        ROOT / "src" / "main" / "background-removal" / "background_remove_batch.py",
        Path(__file__).resolve(),
        *(model_path / filename for filename in MODEL_FILES),
    )
    for input_path in inputs:
        digest.update(str(input_path.name).encode("utf-8"))
        digest.update(sha256(input_path).encode("ascii"))
    digest.update(sys.platform.encode("utf-8"))
    digest.update(platform.machine().encode("utf-8"))
    digest.update(platform.python_version().encode("utf-8"))
    return digest.hexdigest()


def runtime_executable(output: Path) -> Path:
    return output / (
        "background_remove_batch.exe"
        if sys.platform == "win32"
        else "background_remove_batch"
    )


def can_reuse_runtime(output: Path, fingerprint: str) -> bool:
    manifest_path = output / "runtime-manifest.json"
    if not runtime_executable(output).is_file() or not manifest_path.is_file():
        return False
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    if manifest.get("buildFingerprint") != fingerprint:
        return False
    return all((output / "model" / filename).is_file() for filename in MODEL_FILES)


def write_manifest(output: Path, model_path: Path, fingerprint: str) -> None:
    model_manifest = {
        filename: {
            "bytes": (output / "model" / filename).stat().st_size,
            "sha256": sha256(output / "model" / filename),
        }
        for filename in MODEL_FILES
    }
    model_revision = (
        model_path.name
        if model_path.parent.name == "snapshots"
        else None
    )
    manifest = {
        "formatVersion": 1,
        "buildFingerprint": fingerprint,
        "platform": sys.platform,
        "architecture": platform.machine(),
        "python": platform.python_version(),
        "model": {
            "repo": MODEL_REPO,
            "revision": model_revision,
            "files": model_manifest,
        },
        "packages": {
            package: importlib.metadata.version(package)
            for package in PACKAGE_NAMES
        },
    }
    (output / "runtime-manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def verify_runtime(output: Path, run_inference: bool = False) -> None:
    executable = runtime_executable(output)
    if not executable.is_file():
        raise RuntimeError(f"PyInstaller did not create {executable}")

    environment = {
        **os.environ,
        "HF_HUB_OFFLINE": "1",
        "IMAGE_PUMA_BACKGROUND_MODEL_DIR": str(output / "model"),
        "TRANSFORMERS_OFFLINE": "1",
    }
    result = subprocess.run(
        [str(executable), "--self-test"],
        cwd=output,
        env=environment,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        raise RuntimeError(
            "Bundled background remover self-test failed.\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )

    if not run_inference:
        return

    from PIL import Image

    with tempfile.TemporaryDirectory(prefix="image-puma-background-removal-") as temp_dir:
        temp_path = Path(temp_dir)
        source_path = temp_path / "source.png"
        output_path = temp_path / "output.png"
        Image.new("RGB", (32, 32), color=(230, 40, 80)).save(source_path)
        job = {
            "files": [{
                "sourcePath": str(source_path),
                "fileName": "source",
                "extension": ".png",
                "fileSize": source_path.stat().st_size,
                "outputPath": str(output_path),
                "outputFormat": "png",
            }],
            "settings": {
                "destination": "custom",
                "customPath": str(temp_path),
                "outputFormat": "png",
                "overwrite": True,
                "maxWidth": 0,
                "maxHeight": 0,
                "webpQuality": 100,
            },
        }
        inference = subprocess.run(
            [str(executable)],
            cwd=output,
            env=environment,
            input=json.dumps(job),
            capture_output=True,
            text=True,
            timeout=240,
        )
        completed_event = None
        for line in inference.stdout.splitlines():
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if event.get("type") == "file-completed":
                completed_event = event
        result_payload = completed_event.get("result") if completed_event else None
        if (
            inference.returncode != 0
            or not result_payload
            or not result_payload.get("success")
            or not output_path.is_file()
        ):
            raise RuntimeError(
                "Bundled background remover inference test failed.\n"
                f"stdout:\n{inference.stdout}\nstderr:\n{inference.stderr}"
            )


def main() -> int:
    args = parse_args()
    model_path = resolve_model()
    output = args.output.resolve()
    fingerprint = build_fingerprint(model_path)
    if can_reuse_runtime(output, fingerprint):
        verify_runtime(output)
        print(f"Bundled background remover is already current: {output}")
        return 0

    packaged_runtime = run_pyinstaller(args.work_root.resolve())

    shutil.rmtree(output, ignore_errors=True)
    shutil.copytree(packaged_runtime, output, symlinks=False)
    copy_files(model_path, output / "model", (*MODEL_FILES, *OPTIONAL_MODEL_FILES))
    write_manifest(output, model_path, fingerprint)
    verify_runtime(output, run_inference=True)
    print(f"Bundled background remover ready: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
