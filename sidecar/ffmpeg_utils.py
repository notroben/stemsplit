"""FFmpeg discovery, probing, and audio normalization utilities."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

WINDOWS_FALLBACK_FFMPEG_BIN = Path(r"D:\Programs\ffmpeg\bin")
CREATE_NO_WINDOW = 0x08000000


def _subprocess_kwargs() -> dict[str, Any]:
    if os.name == "nt":
        return {"creationflags": CREATE_NO_WINDOW}
    return {}


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


def probe_audio(file_path: str | Path) -> dict[str, Any]:
    """Probe duration, sample rate, and channel count using ffprobe."""
    ensure_ffmpeg_in_path()
    path = Path(file_path)
    if not path.is_file():
        raise FileNotFoundError(f"Audio file not found: {path}")

    cmd = [
        "ffprobe",
        "-hide_banner",
        "-loglevel",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        str(path),
    ]
    try:
        result = subprocess.run(
            cmd,
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            **_subprocess_kwargs(),
        )
    except FileNotFoundError as exc:
        raise RuntimeError("ffprobe executable not found on PATH.") from exc
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or "").strip() or "ffprobe failed to inspect the file."
        raise RuntimeError(f"Failed to probe media file: {detail}") from exc

    data = json.loads(result.stdout or "{}")
    streams = data.get("streams", [])
    audio_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if audio_stream is None:
        raise ValueError("Selected file does not contain a playable audio stream.")

    raw_duration = data.get("format", {}).get("duration") or audio_stream.get("duration") or 0
    try:
        duration = float(raw_duration)
    except (TypeError, ValueError):
        duration = 0.0

    if duration <= 0:
        raise ValueError("Could not determine a valid audio duration for this file.")

    sample_rate = int(audio_stream.get("sample_rate") or 44100)
    channels = int(audio_stream.get("channels") or 2)

    return {
        "duration_sec": round(duration, 2),
        "sample_rate": sample_rate,
        "channels": channels,
    }


def normalize_to_wav(input_path: str | Path, output_wav_path: str | Path) -> None:
    """Decode and normalize any supported audio/video file to 44.1 kHz stereo WAV."""
    ensure_ffmpeg_in_path()
    src = Path(input_path)
    dst = Path(output_wav_path)
    if not src.is_file():
        raise FileNotFoundError(f"Input file not found: {src}")

    dst.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(src),
        "-vn",
        "-acodec",
        "pcm_s16le",
        "-ar",
        "44100",
        "-ac",
        "2",
        str(dst),
    ]
    try:
        subprocess.run(
            cmd,
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            **_subprocess_kwargs(),
        )
    except FileNotFoundError as exc:
        raise RuntimeError("ffmpeg executable not found on PATH.") from exc
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or "").strip() or "ffmpeg failed to normalize input audio."
        raise RuntimeError(f"Audio normalization failed: {detail}") from exc
