"""ML model manager, separation pipeline, SSE progress capture, and job workspace."""

from __future__ import annotations

import asyncio
import contextlib
from dataclasses import dataclass, field
from datetime import datetime, timezone
import gc
import json
import logging
import os
from pathlib import Path
import re
import shutil
import sys
import threading
from typing import Any, Callable, Iterator
from uuid import uuid4

import torch

from ffmpeg_utils import (
    ensure_ffmpeg_in_path,
    export_all_stems_archive,
    export_audio_mix,
    normalize_to_wav,
    probe_audio,
)

# Ensure pydub/audio-separator sees FFmpeg before importing Separator.
ensure_ffmpeg_in_path()
from audio_separator.separator import Separator  # noqa: E402

WORKSPACE_DIR = Path(os.environ.get("STEMSPLIT_HOME", Path.home() / ".stemsplit"))
MODELS_DIR = WORKSPACE_DIR / "models"
JOBS_DIR = WORKSPACE_DIR / "jobs"

STEM_METADATA: dict[str, dict[str, str]] = {
    "vocals": {"id": "vocals", "label": "Vocals", "color": "#2dd4bf", "filename": "Vocals.wav"},
    "instrumental": {
        "id": "instrumental",
        "label": "Instrumental",
        "color": "#f59e0b",
        "filename": "Instrumental.wav",
    },
    "drums": {"id": "drums", "label": "Drums", "color": "#f43f5e", "filename": "Drums.wav"},
    "bass": {"id": "bass", "label": "Bass", "color": "#3b82f6", "filename": "Bass.wav"},
    "guitar": {"id": "guitar", "label": "Guitar", "color": "#a855f7", "filename": "Guitar.wav"},
    "piano": {"id": "piano", "label": "Piano", "color": "#10b981", "filename": "Piano.wav"},
    "other": {"id": "other", "label": "Other", "color": "#eab308", "filename": "Other.wav"},
}

PRESETS: dict[str, dict[str, Any]] = {
    "roformer_2stem": {
        "id": "roformer_2stem",
        "label": "Vocals & Instrumental (Best Quality)",
        "model_filename": "model_bs_roformer_ep_317_sdr_12.9755.ckpt",
        "stems_count": 2,
        "stem_ids": ["vocals", "instrumental"],
        "progress_passes": 1,
        "size_mb": 320,
    },
    "htdemucs_4stem": {
        "id": "htdemucs_4stem",
        "label": "4-Stem Band Split",
        "model_filename": "htdemucs_ft.yaml",
        "stems_count": 4,
        "stem_ids": ["vocals", "drums", "bass", "other"],
        "progress_passes": 4,
        "size_mb": 320,
    },
    "htdemucs_6stem": {
        "id": "htdemucs_6stem",
        "label": "6-Stem Full Split (+ Guitar & Piano)",
        "model_filename": "htdemucs_6s.yaml",
        "stems_count": 6,
        "stem_ids": ["vocals", "drums", "bass", "guitar", "piano", "other"],
        "progress_passes": 1,
        "size_mb": 320,
    },
}

TERMINAL_STAGES = {"completed", "failed", "cancelled"}
PERCENT_PATTERN = re.compile(r"(\d{1,3})%")


class JobCancelledError(Exception):
    """Raised inside tqdm write hooks to unwind inference cooperatively on cancel."""


class TqdmToSSE:
    """Intercept tqdm stderr updates to stream percentage progress and handle cancellation."""

    encoding = "utf-8"

    def __init__(
        self,
        cancel_event: threading.Event,
        on_progress: Callable[[int], None],
        total_passes: int = 1,
    ) -> None:
        self.cancel_event = cancel_event
        self.on_progress = on_progress
        self.total_passes = max(1, total_passes)
        self._pass_index = 0
        self._last_raw_pct = 0
        self._last_emitted = -1

    def isatty(self) -> bool:
        return True

    def write(self, buf: str) -> int:
        if self.cancel_event.is_set():
            raise JobCancelledError("Separation cancelled by user.")

        matches = PERCENT_PATTERN.findall(buf)
        if matches:
            raw_pct = min(100, max(0, int(matches[-1])))
            # Bag-of-models ensembles (e.g., htdemucs_ft) emit 4 sequential 0-100% passes.
            if (
                self.total_passes > 1
                and self._last_raw_pct >= 85
                and raw_pct < self._last_raw_pct
                and self._pass_index + 1 < self.total_passes
            ):
                self._pass_index += 1
            self._last_raw_pct = raw_pct

            overall = int(((self._pass_index * 100) + raw_pct) / self.total_passes)
            overall = min(100, max(0, overall))
            if overall > self._last_emitted:
                self._last_emitted = overall
                self.on_progress(overall)

        return len(buf)

    def flush(self) -> None:
        if self.cancel_event.is_set():
            raise JobCancelledError("Separation cancelled by user.")


@contextlib.contextmanager
def _capture_tqdm_stderr(stream: TqdmToSSE) -> Iterator[None]:
    previous_stderr = sys.stderr
    sys.stderr = stream  # type: ignore[assignment]
    try:
        yield
    finally:
        sys.stderr = previous_stderr


class ModelManager:
    """Maintains at most one Separator model in VRAM at any time."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._separator: Separator | None = None
        self._active_preset_id: str | None = None
        self._active_mdxc_override: dict[str, Any] | None = None

    def unload(self) -> None:
        """Unload the active model and release CUDA cache immediately."""
        if self._separator is not None:
            model_inst = getattr(self._separator, "model_instance", None)
            if model_inst is not None:
                del self._separator.model_instance
                self._separator.model_instance = None
            del self._separator
            self._separator = None
        self._active_preset_id = None
        self._active_mdxc_override = None
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    def prepare_separator(
        self,
        preset_id: str,
        job_dir: Path,
        cancel_event: threading.Event,
        on_model_progress: Callable[[int], None],
        mdxc_override: dict[str, Any] | None = None,
    ) -> Separator:
        """Ensure only the requested preset is loaded in VRAM and configured for job_dir."""
        preset = PRESETS[preset_id]
        needs_load = (
            self._separator is None
            or self._active_preset_id != preset_id
            or self._active_mdxc_override != mdxc_override
        )

        if needs_load:
            self.unload()
            mdxc_params: dict[str, Any] = {
                "segment_size": 256,
                "override_model_segment_size": False,
                "batch_size": 1,
                "overlap": 4,
                "pitch_shift": 0,
            }
            if mdxc_override:
                mdxc_params.update(mdxc_override)

            demucs_params: dict[str, Any] = {
                "segment_size": "Default",
                "segments_enabled": True,
                "shifts": 1,
                "overlap": 0.25,
            }

            separator = Separator(
                log_level=logging.WARNING,
                model_file_dir=str(MODELS_DIR),
                output_dir=str(job_dir),
                output_format="WAV",
                sample_rate=44100,
                use_soundfile=True,
                use_autocast=torch.cuda.is_available(),
                mdxc_params=mdxc_params,
                demucs_params=demucs_params,
            )

            stream = TqdmToSSE(cancel_event=cancel_event, on_progress=on_model_progress, total_passes=1)
            with _capture_tqdm_stderr(stream):
                separator.load_model(model_filename=preset["model_filename"])

            self._separator = separator
            self._active_preset_id = preset_id
            self._active_mdxc_override = dict(mdxc_override) if mdxc_override else None

        assert self._separator is not None
        # Separator copies output_dir onto model_instance at load time; update both per job.
        self._separator.output_dir = str(job_dir)
        if getattr(self._separator, "model_instance", None) is not None:
            self._separator.model_instance.output_dir = str(job_dir)
        return self._separator

    @property
    def lock(self) -> threading.Lock:
        return self._lock


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


def total_cache_bytes() -> int:
    """Return total byte size across all cached job folders."""
    ensure_workspace_dirs()
    return sum(_directory_size_bytes(d) for d in JOBS_DIR.iterdir() if d.is_dir())


def list_jobs() -> dict[str, Any]:
    """Return cached job manifests sorted newest-first along with total cache bytes."""
    ensure_workspace_dirs()
    jobs: list[dict[str, Any]] = []
    cache_bytes = 0

    for job_dir in JOBS_DIR.iterdir():
        if not job_dir.is_dir():
            continue
        manifest_path = job_dir / "manifest.json"
        if not manifest_path.is_file():
            continue
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        job_bytes = _directory_size_bytes(job_dir)
        cache_bytes += job_bytes
        manifest["size_bytes"] = job_bytes
        jobs.append(manifest)

    jobs.sort(key=lambda item: item.get("created_at", ""), reverse=True)
    return {
        "jobs": jobs,
        "total_cache_bytes": cache_bytes,
    }


def get_job_manifest(job_id: str) -> dict[str, Any] | None:
    """Load manifest.json for a single job ID, or return None if missing."""
    if not re.fullmatch(r"[A-Za-z0-9_-]+", job_id):
        return None
    manifest_path = JOBS_DIR / job_id / "manifest.json"
    if not manifest_path.is_file():
        return None
    return json.loads(manifest_path.read_text(encoding="utf-8"))


def delete_job(job_id: str) -> dict[str, Any] | None:
    """Delete a single job folder and return updated cache size, or None if missing."""
    if not re.fullmatch(r"[A-Za-z0-9_-]+", job_id):
        return None
    job_dir = JOBS_DIR / job_id
    if not job_dir.is_dir():
        return None
    shutil.rmtree(job_dir)
    return {
        "deleted_id": job_id,
        "total_cache_bytes": total_cache_bytes(),
    }


def delete_all_jobs() -> dict[str, Any]:
    """Purge all job folders inside JOBS_DIR."""
    ensure_workspace_dirs()
    for entry in JOBS_DIR.iterdir():
        if entry.is_dir():
            shutil.rmtree(entry, ignore_errors=True)
    return {"total_cache_bytes": 0}


def export_job(
    job_id: str,
    target_path: str,
    fmt: str,
    stems_state: list[dict[str, Any]],
    mode: str = "custom_mix",
) -> dict[str, Any]:
    """Render a custom mixdown, single stem, or all-stems archive for a completed job."""
    manifest = get_job_manifest(job_id)
    if manifest is None:
        raise FileNotFoundError(f"Job manifest not found: {job_id}")

    manifest_stems: list[dict[str, Any]] = manifest.get("stems", [])
    if mode == "all_stems_folder":
        return export_all_stems_archive(
            stems=manifest_stems,
            source_name=manifest.get("source_name", job_id),
            target_path=target_path,
            fmt=fmt,
            as_zip=False,
        )
    if mode == "all_stems_zip":
        return export_all_stems_archive(
            stems=manifest_stems,
            source_name=manifest.get("source_name", job_id),
            target_path=target_path,
            fmt=fmt,
            as_zip=True,
        )

    stem_path_by_id = {s["id"]: Path(s["path"]) for s in manifest_stems}
    any_soloed = any(bool(item.get("soloed", False)) for item in stems_state)

    active_weights: list[tuple[Path, float]] = []
    for item in stems_state:
        stem_id = item["id"]
        if stem_id not in stem_path_by_id:
            raise ValueError(f"Unknown stem id '{stem_id}' for job '{job_id}'.")

        muted = bool(item.get("muted", False))
        soloed = bool(item.get("soloed", False))
        volume = float(item.get("volume", 1.0))

        is_audible = (not muted) and ((not any_soloed) or soloed) and volume > 0.0
        if is_audible:
            active_weights.append((stem_path_by_id[stem_id], min(1.5, volume)))

    if not active_weights:
        raise ValueError("All stems are muted or at 0% volume.")

    return export_audio_mix(active_weights, target_path, fmt)


def _rename_outputs_to_canonical(job_dir: Path, expected_stem_ids: list[str]) -> list[dict[str, str]]:
    """Map verbose audio-separator filenames from original.wav to canonical stem WAVs."""
    candidates = [
        path
        for path in job_dir.glob("*.wav")
        if path.name.lower() != "original.wav"
    ]

    stems: list[dict[str, str]] = []
    for stem_id in expected_stem_ids:
        meta = STEM_METADATA[stem_id]
        target_path = job_dir / meta["filename"]

        if not target_path.is_file():
            token = f"_({stem_id})_"
            match = next((p for p in candidates if token in p.name.lower()), None)
            if match is None:
                # Fallback if separator output uses stem name directly.
                match = next(
                    (p for p in candidates if p.stem.lower().startswith(stem_id)),
                    None,
                )
            if match is None:
                raise RuntimeError(f"Expected separated stem output for '{meta['label']}' was not produced.")
            match.replace(target_path)
            candidates = [p for p in candidates if p != match]

        if not target_path.is_file() or target_path.stat().st_size == 0:
            raise RuntimeError(f"Separated stem file is missing or empty: {target_path.name}")

        stems.append(
            {
                "id": meta["id"],
                "label": meta["label"],
                "color": meta["color"],
                "path": target_path.resolve().as_posix(),
            }
        )

    return stems


@dataclass
class JobRecord:
    """In-memory progress state and subscriber registry for one separation job."""

    job_id: str
    file_path: Path
    preset_id: str
    loop: asyncio.AbstractEventLoop
    cancel_event: threading.Event = field(default_factory=threading.Event)
    lock: threading.Lock = field(default_factory=threading.Lock)
    history: list[dict[str, Any]] = field(default_factory=list)
    subscribers: list[asyncio.Queue[dict[str, Any]]] = field(default_factory=list)
    terminal: bool = False


class JobManager:
    """Coordinates asynchronous separation jobs and SSE progress streams."""

    def __init__(self, model_manager: ModelManager) -> None:
        self._model_manager = model_manager
        self._jobs: dict[str, JobRecord] = {}
        self._jobs_lock = threading.Lock()

    def start_job(
        self,
        file_path: str | Path,
        preset_id: str,
        loop: asyncio.AbstractEventLoop,
    ) -> str:
        """Create a job directory, register tracking state, and launch the worker thread."""
        if preset_id not in PRESETS:
            raise ValueError(f"Unknown preset_id: {preset_id}")

        src_path = Path(file_path)
        if not src_path.is_file():
            raise FileNotFoundError(f"Input file does not exist: {src_path}")

        ensure_workspace_dirs()
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        job_id = f"job_{timestamp}_{uuid4().hex[:4]}"

        record = JobRecord(
            job_id=job_id,
            file_path=src_path,
            preset_id=preset_id,
            loop=loop,
        )
        with self._jobs_lock:
            self._jobs[job_id] = record

        self._emit(record, {"stage": "queued", "percent": 0, "message": "Queued for separation"})
        worker = threading.Thread(
            target=self._run_job,
            args=(record,),
            name=f"separate-{job_id}",
            daemon=True,
        )
        worker.start()
        return job_id

    def get_job(self, job_id: str) -> JobRecord | None:
        with self._jobs_lock:
            return self._jobs.get(job_id)

    def cancel_job(self, job_id: str) -> bool:
        record = self.get_job(job_id)
        if record is None:
            return False
        record.cancel_event.set()
        return True

    def forget_job(self, job_id: str) -> None:
        with self._jobs_lock:
            record = self._jobs.get(job_id)
            if record is not None and record.terminal:
                self._jobs.pop(job_id, None)

    def forget_all_jobs(self) -> None:
        with self._jobs_lock:
            self._jobs = {
                jid: rec for jid, rec in self._jobs.items() if not rec.terminal
            }

    def _emit(self, record: JobRecord, payload: dict[str, Any]) -> None:
        stage = payload.get("stage", "")
        with record.lock:
            record.history.append(payload)
            if stage in TERMINAL_STAGES:
                record.terminal = True
            subscribers = list(record.subscribers)

        for queue in subscribers:
            record.loop.call_soon_threadsafe(queue.put_nowait, payload)

    async def subscribe(self, job_id: str) -> Iterator[dict[str, Any]] | Any:
        """Async generator yielding recorded and live events until a terminal stage."""
        record = self.get_job(job_id)
        if record is None:
            raise KeyError(job_id)

        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        with record.lock:
            for item in record.history:
                queue.put_nowait(item)
            already_terminal = record.terminal
            if not already_terminal:
                record.subscribers.append(queue)

        try:
            while True:
                event = await queue.get()
                yield event
                if event.get("stage") in TERMINAL_STAGES:
                    break
                if already_terminal and queue.empty():
                    break
        finally:
            with record.lock:
                if queue in record.subscribers:
                    record.subscribers.remove(queue)

    def _check_cancelled(self, record: JobRecord) -> None:
        if record.cancel_event.is_set():
            raise JobCancelledError("Separation cancelled by user.")

    def _run_job(self, record: JobRecord) -> None:
        job_dir = JOBS_DIR / record.job_id
        preset = PRESETS[record.preset_id]
        original_wav = job_dir / "original.wav"

        try:
            job_dir.mkdir(parents=True, exist_ok=True)
            self._check_cancelled(record)

            # 1. Probing & Normalization
            self._emit(
                record,
                {"stage": "probing", "percent": 0, "message": "Probing and normalizing audio to 44.1 kHz WAV..."},
            )
            probe_info = probe_audio(record.file_path)
            self._check_cancelled(record)
            normalize_to_wav(record.file_path, original_wav)
            self._check_cancelled(record)

            with self._model_manager.lock:
                self._check_cancelled(record)

                # 2. Loading / Downloading Model
                weight_cached = (MODELS_DIR / preset["model_filename"]).is_file()
                load_msg = (
                    "Loading AI model into memory..."
                    if weight_cached
                    else f"Downloading AI model weights (~{preset['size_mb']} MB, one-time)..."
                )
                self._emit(record, {"stage": "loading_model", "percent": 0, "message": load_msg})

                separator = self._model_manager.prepare_separator(
                    preset_id=record.preset_id,
                    job_dir=job_dir,
                    cancel_event=record.cancel_event,
                    on_model_progress=lambda pct: self._emit(
                        record,
                        {"stage": "loading_model", "percent": pct, "message": load_msg},
                    ),
                )
                self._check_cancelled(record)

                # 3. Separating (passing only normalized original.wav)
                self._emit(
                    record,
                    {"stage": "separating", "percent": 0, "message": f"Separating stems ({preset['label']})..."},
                )

                def run_separate(active_separator: Separator) -> None:
                    stream = TqdmToSSE(
                        cancel_event=record.cancel_event,
                        on_progress=lambda pct: self._emit(
                            record,
                            {
                                "stage": "separating",
                                "percent": pct,
                                "message": f"Separating stems ({pct}%)...",
                            },
                        ),
                        total_passes=preset["progress_passes"],
                    )
                    with _capture_tqdm_stderr(stream):
                        active_separator.separate(str(original_wav))

                try:
                    run_separate(separator)
                except torch.cuda.OutOfMemoryError:
                    # Fallback retry once with smaller MDXC segment parameters on 4 GB VRAM GPUs.
                    self._model_manager.unload()
                    self._check_cancelled(record)
                    self._emit(
                        record,
                        {
                            "stage": "separating",
                            "percent": 0,
                            "message": "VRAM peak detected; retrying with reduced segment size...",
                        },
                    )
                    retry_separator = self._model_manager.prepare_separator(
                        preset_id=record.preset_id,
                        job_dir=job_dir,
                        cancel_event=record.cancel_event,
                        on_model_progress=lambda pct: self._emit(
                            record,
                            {"stage": "loading_model", "percent": pct, "message": "Reloading model for low-VRAM retry..."},
                        ),
                        mdxc_override={
                            "segment_size": 128,
                            "override_model_segment_size": True,
                            "overlap": 2,
                        },
                    )
                    run_separate(retry_separator)

            self._check_cancelled(record)

            # 4. Finalizing canonical stem names and manifest.json
            self._emit(record, {"stage": "finalizing", "percent": 99, "message": "Finalizing stem files..."})
            stems = _rename_outputs_to_canonical(job_dir, preset["stem_ids"])
            manifest = {
                "id": record.job_id,
                "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "source_name": record.file_path.name,
                "duration_sec": probe_info["duration_sec"],
                "sample_rate": 44100,
                "preset": record.preset_id,
                "status": "completed",
                "original_path": original_wav.resolve().as_posix(),
                "stems": stems,
            }
            manifest_path = job_dir / "manifest.json"
            manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

            self._emit(
                record,
                {
                    "stage": "completed",
                    "percent": 100,
                    "message": "Separation complete",
                    "job_id": record.job_id,
                },
            )
        except JobCancelledError:
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            shutil.rmtree(job_dir, ignore_errors=True)
            self._emit(
                record,
                {"stage": "cancelled", "percent": 0, "message": "Separation cancelled"},
            )
        except Exception as exc:
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            shutil.rmtree(job_dir, ignore_errors=True)
            self._emit(
                record,
                {"stage": "failed", "percent": 0, "message": str(exc) or "Separation failed"},
            )
