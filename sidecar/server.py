"""FastAPI HTTP sidecar server and parent-PID watchdog for StemSplit."""

from __future__ import annotations

import argparse
import asyncio
import ctypes
import json
import os
import threading
import time
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ffmpeg_utils import check_ffmpeg, ensure_ffmpeg_in_path, probe_audio
from worker import (
    PRESETS,
    JobManager,
    ModelManager,
    delete_all_jobs,
    delete_job,
    ensure_workspace_dirs,
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


class ProbeRequest(BaseModel):
    file_path: str


class SeparateRequest(BaseModel):
    file_path: str
    preset_id: str


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
    return result


@app.delete("/jobs")
def remove_all_jobs() -> dict[str, Any]:
    """Purge all cached job folders."""
    return delete_all_jobs()


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

    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
