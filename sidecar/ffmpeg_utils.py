"""FFmpeg discovery and path utilities for the StemSplit sidecar."""

from __future__ import annotations

import os
import shutil
from pathlib import Path

WINDOWS_FALLBACK_FFMPEG_BIN = Path(r"D:\Programs\ffmpeg\bin")


def ensure_ffmpeg_in_path() -> None:
    """Ensure the D:\\Programs\\ffmpeg\\bin fallback directory is on PATH if present."""
    if os.name != "nt" or not WINDOWS_FALLBACK_FFMPEG_BIN.is_dir():
        return

    current_path = os.environ.get("PATH", "")
    entries = [p.strip().lower() for p in current_path.split(os.pathsep) if p.strip()]
    target = str(WINDOWS_FALLBACK_FFMPEG_BIN)
    if target.lower() not in entries:
        os.environ["PATH"] = f"{target}{os.pathsep}{current_path}" if current_path else target


def check_ffmpeg() -> bool:
    """Return True only when both ffmpeg and ffprobe executables are resolvable."""
    ensure_ffmpeg_in_path()
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None
