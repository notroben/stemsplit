"""FastAPI HTTP sidecar server and parent-PID watchdog for StemSplit."""

from __future__ import annotations

import argparse
import asyncio
import ctypes
import json
import os
from pathlib import Path
import threading
import time
from typing import Any, Literal
from uuid import uuid4

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from pydantic import BaseModel

from ffmpeg_utils import check_ffmpeg, ensure_ffmpeg_in_path, probe_audio
from mobile_ui import MOBILE_HTML, LanServerManager
from worker import (
    JOBS_DIR,
    PRESETS,
    WORKSPACE_DIR,
    JobManager,
    ModelManager,
    delete_all_jobs,
    delete_job,
    ensure_workspace_dirs,
    export_job,
    get_hardware_info,
    get_job_manifest,
    list_jobs,
    list_models_status,
)

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
STILL_ACTIVE = 259

app = FastAPI(title="StemSplit Sidecar", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

model_manager = ModelManager()
job_manager = JobManager(model_manager)
lan_manager = LanServerManager()


class ProbeRequest(BaseModel):
    file_path: str


class SeparateRequest(BaseModel):
    file_path: str
    preset_id: str


class ExportStemState(BaseModel):
    id: str
    volume: float = 1.0
    muted: bool = False
    soloed: bool = False


class ExportRequest(BaseModel):
    job_id: str
    target_path: str
    format: Literal["mp3", "wav", "flac"] = "mp3"
    stems: list[ExportStemState] = []
    mode: Literal["custom_mix", "single_stem", "all_stems_folder", "all_stems_zip"] = "custom_mix"


class LanToggleRequest(BaseModel):
    enabled: bool


class MobileMixRequest(BaseModel):
    stems: list[ExportStemState] = []


def _is_parent_alive(parent_pid: int) -> bool:
    if os.name == "nt":
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, parent_pid)
        if not handle:
            return False
        try:
            exit_code = ctypes.c_ulong()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                return False
            return exit_code.value == STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)

    try:
        os.kill(parent_pid, 0)
        return True
    except OSError:
        return False


def _start_parent_watchdog(parent_pid: int) -> None:
    """Exit immediately if the Tauri host process terminates unexpectedly."""

    def watchdog_loop() -> None:
        while True:
            time.sleep(0.5)
            if not _is_parent_alive(parent_pid):
                os._exit(0)

    thread = threading.Thread(target=watchdog_loop, name="parent-pid-watchdog", daemon=True)
    thread.start()


@app.get("/health")
def health() -> dict[str, Any]:
    """Report sidecar readiness, active PyTorch device, and FFmpeg availability."""
    hw = get_hardware_info()
    return {
        "status": "ok",
        "device": hw["device"],
        "gpu_name": hw["gpu_name"],
        "vram_mb": hw["vram_mb"],
        "ffmpeg_ok": check_ffmpeg(),
    }


@app.get("/models")
def models() -> list[dict[str, Any]]:
    """List curated presets and whether their weights are cached locally."""
    return list_models_status()


@app.post("/probe")
def probe(req: ProbeRequest) -> dict[str, Any]:
    """Validate an input file and return duration, sample rate, and channel info."""
    try:
        info = probe_audio(req.file_path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {
        "source_name": os.path.basename(req.file_path),
        **info,
    }


@app.post("/separate", status_code=202)
async def separate(req: SeparateRequest) -> dict[str, str]:
    """Start an asynchronous separation job and return its job_id immediately."""
    if req.preset_id not in PRESETS:
        raise HTTPException(status_code=400, detail=f"Invalid preset_id: {req.preset_id}")

    loop = asyncio.get_running_loop()
    try:
        job_id = job_manager.start_job(req.file_path, req.preset_id, loop)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return {"job_id": job_id}


@app.get("/jobs/{job_id}/events")
async def job_events(job_id: str) -> StreamingResponse:
    """Stream Server-Sent Events for a separation job until it reaches a terminal stage."""
    if job_manager.get_job(job_id) is None:
        raise HTTPException(status_code=404, detail=f"Job not found: {job_id}")

    async def event_stream():
        async for event in job_manager.subscribe(job_id):
            yield f"data: {json.dumps(event)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> dict[str, str]:
    """Request cooperative cancellation of an in-flight separation job."""
    if not job_manager.cancel_job(job_id):
        raise HTTPException(status_code=404, detail=f"Job not found: {job_id}")
    return {"job_id": job_id, "status": "cancelling"}


@app.get("/jobs")
def jobs() -> dict[str, Any]:
    """List cached separation jobs and total workspace disk usage."""
    return list_jobs()


@app.get("/jobs/{job_id}")
def job_detail(job_id: str) -> dict[str, Any]:
    """Return manifest.json for a completed job."""
    manifest = get_job_manifest(job_id)
    if manifest is None:
        raise HTTPException(status_code=404, detail=f"Job manifest not found: {job_id}")
    return manifest


@app.delete("/jobs/{job_id}")
def remove_job(job_id: str) -> dict[str, Any]:
    """Delete a cached job folder and return updated cache size."""
    result = delete_job(job_id)
    if result is None:
        raise HTTPException(status_code=404, detail=f"Job not found: {job_id}")
    job_manager.forget_job(job_id)
    return result


@app.delete("/jobs")
def remove_all_jobs() -> dict[str, Any]:
    """Purge all cached job folders."""
    result = delete_all_jobs()
    job_manager.forget_all_jobs()
    return result


@app.post("/export")
def export_mix(req: ExportRequest) -> dict[str, Any]:
    """Render a custom stem mixdown, single stem, or batch stem export via FFmpeg."""
    try:
        return export_job(
            job_id=req.job_id,
            target_path=req.target_path,
            fmt=req.format,
            stems_state=[s.model_dump() for s in req.stems],
            mode=req.mode,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/lan/status")
def lan_status() -> dict[str, Any]:
    """Return current LAN Companion listener status, URL, and inline QR SVG."""
    return lan_manager.status()


@app.post("/lan/toggle")
def lan_toggle(req: LanToggleRequest) -> dict[str, Any]:
    """Start or stop the auxiliary 0.0.0.0 LAN listener for mobile companion access."""
    try:
        if req.enabled:
            return lan_manager.start(app)
        return lan_manager.stop()
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/", response_class=HTMLResponse)
@app.get("/mobile", response_class=HTMLResponse)
def mobile_page() -> HTMLResponse:
    """Serve the lightweight mobile companion UI over the local Wi-Fi listener."""
    return HTMLResponse(content=MOBILE_HTML)


@app.post("/mobile/upload", status_code=202)
async def mobile_upload(
    request: Request,
    preset_id: str = "roformer_2stem",
    filename: str = "upload.mp3",
) -> dict[str, str]:
    """Stream an uploaded audio/video file from a phone and start GPU separation."""
    if preset_id not in PRESETS:
        raise HTTPException(status_code=400, detail=f"Invalid preset_id: {preset_id}")

    base = os.path.basename(filename).strip()
    safe_name = "".join("_" if c in '<>:"/\\|?*' else c for c in base).strip(" .") or "upload.audio"
    uploads_dir = WORKSPACE_DIR / "uploads"
    uploads_dir.mkdir(parents=True, exist_ok=True)
    upload_path = uploads_dir / f"{uuid4().hex}_{safe_name}"

    total_bytes = 0
    try:
        with upload_path.open("wb") as out_file:
            async for chunk in request.stream():
                if not chunk:
                    continue
                out_file.write(chunk)
                total_bytes += len(chunk)
    except Exception as exc:
        upload_path.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"Failed to receive upload: {exc}") from exc

    if total_bytes == 0:
        upload_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    loop = asyncio.get_running_loop()
    try:
        job_id = job_manager.start_job(upload_path, preset_id, loop)
    except Exception as exc:
        upload_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return {"job_id": job_id}


@app.post("/mobile/jobs/{job_id}/mix")
def mobile_download_mix(job_id: str, req: MobileMixRequest) -> FileResponse:
    """Render and stream a custom MP3 mixdown directly back to a mobile browser."""
    manifest = get_job_manifest(job_id)
    if manifest is None:
        raise HTTPException(status_code=404, detail=f"Job manifest not found: {job_id}")

    target_path = JOBS_DIR / job_id / "mobile_export.mp3"
    try:
        result = export_job(
            job_id=job_id,
            target_path=str(target_path),
            fmt="mp3",
            stems_state=[s.model_dump() for s in req.stems],
            mode="custom_mix",
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    base_name = Path(manifest.get("source_name", job_id)).stem
    return FileResponse(
        path=result["saved_path"],
        media_type="audio/mpeg",
        filename=f"{base_name} (StemSplit Mix).mp3",
    )


@app.get("/mobile/jobs/{job_id}/stem/{stem_id}")
def mobile_download_stem(job_id: str, stem_id: str) -> FileResponse:
    """Encode and stream a single separated stem as 320 kbps MP3 to a mobile browser."""
    manifest = get_job_manifest(job_id)
    if manifest is None:
        raise HTTPException(status_code=404, detail=f"Job manifest not found: {job_id}")

    stem_meta = next((s for s in manifest.get("stems", []) if s["id"] == stem_id), None)
    if stem_meta is None:
        raise HTTPException(status_code=404, detail=f"Stem '{stem_id}' not found in job '{job_id}'")

    target_path = JOBS_DIR / job_id / f"mobile_{stem_id}.mp3"
    try:
        result = export_job(
            job_id=job_id,
            target_path=str(target_path),
            fmt="mp3",
            stems_state=[{"id": stem_id, "volume": 1.0, "muted": False, "soloed": False}],
            mode="single_stem",
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    base_name = Path(manifest.get("source_name", job_id)).stem
    return FileResponse(
        path=result["saved_path"],
        media_type="audio/mpeg",
        filename=f"{base_name} - {stem_meta['label']}.mp3",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="StemSplit Python FastAPI sidecar")
    parser.add_argument("--host", default="127.0.0.1", help="Host interface to bind")
    parser.add_argument("--port", type=int, default=18420, help="TCP port to bind")
    parser.add_argument(
        "--parent-pid",
        type=int,
        default=None,
        help="Optional parent process PID; sidecar exits if parent disappears",
    )
    args = parser.parse_args()

    ensure_ffmpeg_in_path()
    ensure_workspace_dirs()

    if args.parent_pid is not None:
        _start_parent_watchdog(args.parent_pid)

    try:
        uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
    finally:
        lan_manager.stop()


if __name__ == "__main__":
    main()
