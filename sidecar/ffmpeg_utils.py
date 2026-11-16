"""FFmpeg discovery, probing, and audio normalization utilities."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
import tempfile
from typing import Any
import zipfile

WINDOWS_FALLBACK_FFMPEG_BIN = Path(r"D:\Programs\ffmpeg\bin")
CREATE_NO_WINDOW = 0x08000000

EXPORT_CODEC_ARGS: dict[str, list[str]] = {
    "mp3": ["-c:a", "libmp3lame", "-b:a", "320k", "-ar", "44100", "-ac", "2"],
    "wav": ["-c:a", "pcm_s16le", "-ar", "44100", "-ac", "2"],
    "flac": ["-c:a", "flac", "-ar", "44100", "-ac", "2"],
}


def _subprocess_kwargs() -> dict[str, Any]:
    if os.name == "nt":
        return {"creationflags": CREATE_NO_WINDOW}
    return {}


def _run_ffmpeg(args: list[str], error_context: str) -> None:
    ensure_ffmpeg_in_path()
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args]
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
        detail = (exc.stderr or "").strip() or error_context
        raise RuntimeError(f"{error_context}: {detail}") from exc


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
    src = Path(input_path)
    dst = Path(output_wav_path)
    if not src.is_file():
        raise FileNotFoundError(f"Input file not found: {src}")

    dst.parent.mkdir(parents=True, exist_ok=True)
    _run_ffmpeg(
        [
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
        ],
        "Audio normalization failed",
    )


def _sanitize_export_stem_name(name: str) -> str:
    cleaned = "".join("_" if c in '<>:"/\\|?*' else c for c in name).strip(" .")
    return cleaned or "stemsplit_export"


def export_audio_mix(
    stem_weights: list[tuple[Path, float]],
    target_path: str | Path,
    fmt: str,
) -> dict[str, Any]:
    """Mix active stems via FFmpeg amix with normalize=0 and a safety limiter."""
    normalized_fmt = fmt.lower()
    if normalized_fmt not in EXPORT_CODEC_ARGS:
        raise ValueError(f"Unsupported export format: {fmt}")
    if not stem_weights:
        raise ValueError("At least one active stem is required for export.")

    dst = Path(target_path)
    dst.parent.mkdir(parents=True, exist_ok=True)

    args: list[str] = []
    weights: list[str] = []
    for src_path, weight in stem_weights:
        if not src_path.is_file():
            raise FileNotFoundError(f"Stem audio file not found: {src_path}")
        if weight <= 0:
            raise ValueError(f"Stem export weight must be positive, got {weight}")
        args.extend(["-i", str(src_path)])
        weights.append(f"{weight:.6g}")

    weights_str = " ".join(weights)
    filter_graph = (
        f"amix=inputs={len(stem_weights)}:duration=longest:dropout_transition=0:"
        f"weights='{weights_str}':normalize=0,alimiter=limit=0.99:level=disabled[out]"
    )
    args.extend(["-filter_complex", filter_graph, "-map", "[out]", *EXPORT_CODEC_ARGS[normalized_fmt], str(dst)])

    _run_ffmpeg(args, "Audio mixdown export failed")

    if not dst.is_file() or dst.stat().st_size == 0:
        raise RuntimeError(f"FFmpeg did not produce a valid output file at {dst}")

    return {
        "saved_path": str(dst.resolve()),
        "bytes": dst.stat().st_size,
    }


def export_all_stems_archive(
    stems: list[dict[str, Any]],
    source_name: str,
    target_path: str | Path,
    fmt: str,
    as_zip: bool,
) -> dict[str, Any]:
    """Encode every stem in a job to target format and write either a folder or a .zip archive."""
    normalized_fmt = fmt.lower()
    if normalized_fmt not in EXPORT_CODEC_ARGS:
        raise ValueError(f"Unsupported export format: {fmt}")
    if not stems:
        raise ValueError("Job manifest contains no stems to export.")

    base_name = _sanitize_export_stem_name(Path(source_name).stem)
    codec_args = EXPORT_CODEC_ARGS[normalized_fmt]
    dst = Path(target_path)

    if as_zip:
        dst.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=str(dst.parent), prefix="stemsplit_zip_") as tmp_dir:
            tmp_path = Path(tmp_dir)
            rendered_files: list[Path] = []
            for stem in stems:
                src = Path(stem["path"])
                if not src.is_file():
                    raise FileNotFoundError(f"Stem audio file not found: {src}")
                label = _sanitize_export_stem_name(stem["label"])
                out_file = tmp_path / f"{base_name} - {label}.{normalized_fmt}"
                _run_ffmpeg(["-i", str(src), *codec_args, str(out_file)], f"Failed to encode {label}")
                rendered_files.append(out_file)

            with zipfile.ZipFile(dst, "w", compression=zipfile.ZIP_DEFLATED) as zf:
                for item in rendered_files:
                    zf.write(item, arcname=item.name)

        return {
            "saved_path": str(dst.resolve()),
            "bytes": dst.stat().st_size,
        }

    dst.mkdir(parents=True, exist_ok=True)
    total_bytes = 0
    for stem in stems:
        src = Path(stem["path"])
        if not src.is_file():
            raise FileNotFoundError(f"Stem audio file not found: {src}")
        label = _sanitize_export_stem_name(stem["label"])
        out_file = dst / f"{base_name} - {label}.{normalized_fmt}"
        _run_ffmpeg(["-i", str(src), *codec_args, str(out_file)], f"Failed to encode {label}")
        total_bytes += out_file.stat().st_size

    return {
        "saved_path": str(dst.resolve()),
        "bytes": total_bytes,
    }
