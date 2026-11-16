"""ML model catalog, hardware detection, and local workspace helpers."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import torch

WORKSPACE_DIR = Path(os.environ.get("STEMSPLIT_HOME", Path.home() / ".stemsplit"))
MODELS_DIR = WORKSPACE_DIR / "models"
JOBS_DIR = WORKSPACE_DIR / "jobs"

PRESETS: dict[str, dict[str, Any]] = {
    "roformer_2stem": {
        "id": "roformer_2stem",
        "label": "Vocals & Instrumental (Best Quality)",
        "model_filename": "model_bs_roformer_ep_317_sdr_12.9755.ckpt",
        "stems_count": 2,
        "size_mb": 320,
    },
    "htdemucs_4stem": {
        "id": "htdemucs_4stem",
        "label": "4-Stem Band Split",
        "model_filename": "htdemucs_ft.yaml",
        "stems_count": 4,
        "size_mb": 320,
    },
    "htdemucs_6stem": {
        "id": "htdemucs_6stem",
        "label": "6-Stem Full Split (+ Guitar & Piano)",
        "model_filename": "htdemucs_6s.yaml",
        "stems_count": 6,
        "size_mb": 320,
    },
}


def ensure_workspace_dirs() -> None:
    """Create the local model cache and job workspace directories if missing."""
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    JOBS_DIR.mkdir(parents=True, exist_ok=True)


def get_hardware_info() -> dict[str, Any]:
    """Detect the active PyTorch compute device, GPU name, and VRAM capacity."""
    if torch.cuda.is_available():
        props = torch.cuda.get_device_properties(0)
        return {
            "device": "cuda",
            "gpu_name": torch.cuda.get_device_name(0),
            "vram_mb": int(props.total_memory // (1024 * 1024)),
        }

    mps_backend = getattr(torch.backends, "mps", None)
    if mps_backend is not None and mps_backend.is_available():
        return {
            "device": "mps",
            "gpu_name": "Apple Silicon (MPS)",
            "vram_mb": None,
        }

    return {
        "device": "cpu",
        "gpu_name": None,
        "vram_mb": None,
    }


def list_models_status() -> list[dict[str, Any]]:
    """Return the three canonical presets with local cache presence flags."""
    ensure_workspace_dirs()
    results: list[dict[str, Any]] = []
    for preset in PRESETS.values():
        weight_path = MODELS_DIR / preset["model_filename"]
        results.append(
            {
                "id": preset["id"],
                "label": preset["label"],
                "stems_count": preset["stems_count"],
                "size_mb": preset["size_mb"],
                "is_downloaded": weight_path.is_file(),
            }
        )
    return results


def _directory_size_bytes(directory: Path) -> int:
    total = 0
    for entry in directory.rglob("*"):
        if entry.is_file():
            total += entry.stat().st_size
    return total


def list_jobs() -> dict[str, Any]:
    """Return cached job manifests sorted newest-first along with total cache bytes."""
    ensure_workspace_dirs()
    jobs: list[dict[str, Any]] = []
    total_cache_bytes = 0

    for job_dir in JOBS_DIR.iterdir():
        if not job_dir.is_dir():
            continue
        total_cache_bytes += _directory_size_bytes(job_dir)
        manifest_path = job_dir / "manifest.json"
        if not manifest_path.is_file():
            continue
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        jobs.append(manifest)

    jobs.sort(key=lambda item: item.get("created_at", ""), reverse=True)
    return {
        "jobs": jobs,
        "total_cache_bytes": total_cache_bytes,
    }
