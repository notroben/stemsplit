"""FastAPI HTTP sidecar server and parent-PID watchdog for StemSplit."""

from __future__ import annotations

import argparse
import ctypes
import os
import threading
import time
from typing import Any

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from ffmpeg_utils import check_ffmpeg, ensure_ffmpeg_in_path
from worker import ensure_workspace_dirs, get_hardware_info, list_jobs, list_models_status

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
STILL_ACTIVE = 259

app = FastAPI(title="StemSplit Sidecar", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


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


@app.get("/jobs")
def jobs() -> dict[str, Any]:
    """List cached separation jobs and total workspace disk usage."""
    return list_jobs()


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
