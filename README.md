# StemSplit

**Local-first AI stem separator and multi-track DAW mixer** built with **Tauri v2**, **React + TypeScript**, and a **Python FastAPI + PyTorch CUDA** sidecar.

Split any local audio or video file into isolated stems (`Vocals`, `Instrumental`, `Drums`, `Bass`, `Guitar`, `Piano`, `Other`) on your own GPU with zero paywalls, zero upload wait times, and sample-accurate Web Audio playback.

---

## Key Capabilities

- **100% Local GPU Execution:** Runs state-of-the-art open-source weights (`BS-RoFormer` and Meta `HTDemucs`) on local NVIDIA CUDA (4 GB+ VRAM safe defaults via FP16 autocast), Apple Silicon MPS, or CPU fallback.
- **Zero-Copy Audio Transport:** Stems are written directly to `~/.stemsplit/jobs/<job_id>/*.wav` and read by the UI via Tauri's `asset://` protocol — never base64-encoded over JSON.
- **Sample-Accurate DAW Mixer:** Shared `AudioContext` transport with click-free `GainNode` ramping for Solo (`S`), Mute (`M`), per-stem faders, `<canvas>` waveform seeking, and phase-locked **A/B Original** comparison.
- **Custom Mixdown & Stem Export:** Save individual stems, batch-export all stems to a folder or `.zip`, or bounce your current mixer state (e.g., *"everything except drums"*) to `.mp3` (`320 kbps`), `.wav`, or `.flac` via FFmpeg.
- **Clean Process Lifecycle:** Closing the desktop window terminates the entire Python sidecar process tree immediately (`taskkill /F /T` on Windows plus a `--parent-pid` watchdog thread) so VRAM never stays locked.

---

## Curated Separation Models

Weights are downloaded lazily on first use into `~/.stemsplit/models/`:

| Preset ID | UI Label | Underlying Model | Stems |
|---|---|---|---|
| `roformer_2stem` | Vocals & Instrumental (Best Quality) | `model_bs_roformer_ep_317_sdr_12.9755.ckpt` | `Vocals`, `Instrumental` |
| `htdemucs_4stem` | 4-Stem Band Split | `htdemucs_ft.yaml` | `Vocals`, `Drums`, `Bass`, `Other` |
| `htdemucs_6stem` | 6-Stem Full Split (+ Guitar & Piano) | `htdemucs_6s.yaml` | `Vocals`, `Drums`, `Bass`, `Guitar`, `Piano`, `Other` |

---

## Architecture

```
stemsplit/
├── TECHNICAL_DESIGN.md      # Authoritative specification & "As built" notes
├── AGENTS.md                # Engineering invariants & phase verification gates
├── src/                     # React + TypeScript UI & Web Audio mixer
├── src-tauri/               # Rust OS shell, sidecar supervisor, capabilities
└── sidecar/                 # Python 3.11 FastAPI + python-audio-separator + FFmpeg
```

| Layer | Responsibility |
|---|---|
| **Desktop Shell (`src-tauri/`)** | Allocates a free localhost port (`127.0.0.1:0`), spawns `sidecar/server.py` silently (`CREATE_NO_WINDOW`), scopes `asset://` access, and kills the sidecar tree on exit. |
| **Frontend (`src/`)** | Displays hardware pre-flight status, streams SSE progress (`EventSource`), renders `<canvas>` waveforms, and drives synchronized multi-stem playback. |
| **Sidecar (`sidecar/`)** | Probes hardware & FFmpeg, manages one active `Separator` model at a time, streams `tqdm` progress over SSE, and runs FFmpeg decode/mixdown/export subprocesses. |

---

## Prerequisites & Setup (Windows)

### 1. System Prerequisites
- **Node.js** (v20+ recommended; verified on `v22.17.0`)
- **Rust toolchain** (`cargo` / `rustc`)
- **FFmpeg** (`ffmpeg` and `ffprobe` on `PATH`)
- **Python 3.11 (64-bit)** (installed alongside `py` launcher; Python 3.11 is used for clean PyTorch CUDA and `onnxruntime-gpu` wheels on Windows)

### 2. Install Frontend Dependencies
```powershell
npm install
```

### 3. Create Python 3.11 Sidecar Environment
```powershell
py -3.11 -m venv sidecar/.venv
.\sidecar\.venv\Scripts\python.exe -m pip install --upgrade pip
.\sidecar\.venv\Scripts\python.exe -m pip install -r sidecar/requirements.txt
```

Verify that FFmpeg and PyTorch CUDA are detected cleanly:
```powershell
.\sidecar\.venv\Scripts\audio-separator.exe --env_info
```

---

## Running & Building

### Desktop App (Development)
Starts Vite (`http://localhost:1420`), builds/launches the Tauri v2 window, and automatically spawns and supervises the Python sidecar:
```powershell
npm run tauri dev
```

### Desktop App (Release Build)
```powershell
npm run tauri build
```

### Standalone Sidecar Check
You can also run and probe the FastAPI backend independently of Tauri:
```powershell
.\sidecar\.venv\Scripts\python.exe sidecar\server.py --port 18420
# Probe: GET http://127.0.0.1:18420/health
```

---

## Project Roadmap

| Phase | Scope | Status |
|---|---|---|
| **Phase 0 — Foundation** | Python 3.11 CUDA venv, FFmpeg check, FastAPI `/health` + `/models`, Tauri v2 spawn & tree-kill lifecycle | ✅ Complete & Verified |
| **Phase 1 — Separation Core** | Drag-and-drop ingest, `ffprobe` pre-flight, `original.wav` normalization, `Separator` pipeline & SSE progress | ✅ Complete & Verified |
| **Phase 2 — DAW Mixer & Export** | Synchronized Web Audio multi-track player, `<canvas>` waveforms, Solo/Mute/A-B Original, FFmpeg export | ✅ Complete & Verified |
| **Phase 3 — History & Cache** | Collapsible history drawer, instant job reload, cache usage indicator & purge | ✅ Complete & Verified |
| **Phase 4 — LAN Mobile Mode** | Optional Wi-Fi `0.0.0.0` listener + QR code for mobile upload/download | Optional |

---

## Documentation

- [TECHNICAL_DESIGN.md](./TECHNICAL_DESIGN.md) — Full architecture, API contracts, data schemas, UI tokens, and *"As built"* notes.
- [AGENTS.md](./AGENTS.md) — Non-negotiable engineering invariants, layer boundaries, and phase verification gates.
