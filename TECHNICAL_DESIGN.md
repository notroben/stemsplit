# StemSplit — Technical Design Document: Local AI Stem Separator

> **Version:** 1.0
> **Last Updated:** 2026-11-16

---

## Table of Contents

0. [Status](#0-status)
1. [Summary & Scope](#1-summary--scope)
   - 1.1 [What This Builds](#11-what-this-builds)
   - 1.2 [Decision Log](#12-decision-log)
   - 1.3 [What "Done" Looks Like](#13-what-done-looks-like)
2. [Scope](#2-scope)
   - 2.1 [In Scope](#21-in-scope)
   - 2.2 [Explicitly Out of Scope](#22-explicitly-out-of-scope)
3. [Architecture](#3-architecture)
   - 3.1 [System Overview](#31-system-overview)
   - 3.2 [Core Design Principles](#32-core-design-principles)
   - 3.3 [Why Tauri + Python Sidecar (and Why Not Pure Rust)](#33-why-tauri--python-sidecar-and-why-not-pure-rust)
   - 3.4 [File & Folder Structure](#34-file--folder-structure)
   - 3.5 [Environments & Packaging](#35-environments--packaging)
4. [Platform & ML Stack](#4-platform--ml-stack)
   - 4.1 [Why Vercel & Free Cloud Hosting Were Rejected](#41-why-vercel--free-cloud-hosting-were-rejected)
   - 4.2 [Inference Engine — `python-audio-separator`](#42-inference-engine--python-audio-separator)
   - 4.3 [Model Lineup: BS-RoFormer vs. HTDemucs](#43-model-lineup-bs-roformer-vs-htdemucs)
   - 4.4 [Hardware, CUDA & VRAM Constraints](#44-hardware-cuda--vram-constraints)
5. [Data & IPC Contract](#5-data--ipc-contract)
   - 5.1 [Overview](#51-overview)
   - 5.2 [Job State Machine & Local Storage](#52-job-state-machine--local-storage)
   - 5.3 [Sidecar API Specification](#53-sidecar-api-specification)
   - 5.4 [Process Lifecycle & Security Model](#54-process-lifecycle--security-model)
6. [Feature Specifications](#6-feature-specifications)
   - 6.1 [(A) Audio Ingest & FFmpeg Pre-Flight](#61-a-audio-ingest--ffmpeg-pre-flight--phase-1)
   - 6.2 [(B) AI Separation Pipeline & Model Manager](#62-b-ai-separation-pipeline--model-manager--phase-1)
   - 6.3 [(C) Multi-Track DAW Mixer & Synchronized Playback](#63-c-multi-track-daw-mixer--synchronized-playback--phase-2)
   - 6.4 [(D) Stem Export & Custom Mixdown](#64-d-stem-export--custom-mixdown--phase-2)
   - 6.5 [(E) Job History & Cache Management](#65-e-job-history--cache-management--phase-3)
   - 6.6 [(F) LAN Mobile Companion Mode](#66-f-lan-mobile-companion-mode--phase-4--optional)
7. [Desktop UI & Design System](#7-desktop-ui--design-system)
   - 7.1 [Visual Language & Tokens](#71-visual-language--tokens)
   - 7.2 [Screen Layout](#72-screen-layout)
   - 7.3 [Mixer Ergonomics & Keyboard Shortcuts](#73-mixer-ergonomics--keyboard-shortcuts)
8. [Cost & Resource Analysis](#8-cost--resource-analysis)
   - 8.1 [One-Time Development Effort](#81-one-time-development-effort)
   - 8.2 [Recurring Cost](#82-recurring-cost)
   - 8.3 [Disk & Memory Footprint](#83-disk--memory-footprint)
9. [Roadmap & Back-Out Criteria](#9-roadmap--back-out-criteria)
   - 9.1 [Principles](#91-principles)
   - 9.2 [Phases](#92-phases)
   - 9.3 [Sequencing Notes](#93-sequencing-notes)
   - 9.4 [Back-Out Criteria — When to Stop](#94-back-out-criteria--when-to-stop)
10. [Risks & Mitigations](#10-risks--mitigations)
11. [Remaining Open Decisions](#11-remaining-open-decisions)

---

## 0. Status

**Status:** ✅ **Phases 0–2 complete and verified (2026-11-16) · Target desktop deliverable ready (Phase 3 History & Cache next).**
Python 3.11 CUDA sidecar (`torch 2.5.1+cu121`, `audio-separator 0.48.0`, FFmpeg 9.0.2), Tauri v2
desktop shell (`stemsplit.exe` + `open_folder`), drag-and-drop / `ffprobe` ingest (`POST /probe`),
`BS-RoFormer` / `HTDemucs` separation pipeline (`POST /separate`), live `TqdmToSSE` progress
streaming (`GET /jobs/{id}/events`), sample-accurate Web Audio DAW mixer (`MixerView.tsx`), and
FFmpeg custom mixdown / stem export (`POST /export`) are built and verified.

- **Phases 0–2 are the target deliverable** — a complete, self-contained desktop application that
  splits any local song into isolated stems, lets the user solo/mute/mix them in real time, and
  exports clean `.wav` or `.mp3` files with zero subscription limits.
- **Phase 3 (History & Cache)** is a quality-of-life layer so previously split songs reopen
  instantly without re-running GPU inference.
- **Phase 4 (LAN Mobile Companion Mode)** is an optional extension that bridges the original
  "use it from my phone" goal by exposing the desktop sidecar over local Wi-Fi with a scannable QR
  code — specified here so nothing in Phases 0–2 prevents it, but not required for the desktop app
  to be done.

---

## 1. Summary & Scope

### 1.1 What This Builds

Web-based stem splitters like `vocalremover.org` prove the UX: drop a song in, wait a moment, drag
the **Music** slider down to $0\%$, and save the isolated vocal. The problem is not the workflow —
it is the paywall (one free song before requiring a subscription) and the round-trip upload wait.

**StemSplit** is a personal, local-first desktop application built in **Google Antigravity IDE**
that runs the same — or better — state-of-the-art open-source separation weights (`BS-RoFormer` and
`HTDemucs`) directly on local hardware. A Tauri v2 desktop window provides a responsive multi-track
mixer (waveforms, Solo/Mute buttons, volume faders, and custom mixdown export), while a managed
Python FastAPI sidecar handles PyTorch/CUDA inference and FFmpeg encoding behind the scenes.

### 1.2 Decision Log

| # | Decision | Outcome | Decided |
|---|---|---|---|
| **D1** | Form factor | **Local desktop application** over a cloud-hosted web app. Local GPU execution eliminates paywalls, upload wait times, and cloud memory limits | 2026-11-16 |
| **D2** | Cloud hosting (Vercel) | **Rejected.** Vercel Hobby functions cap request payloads at 4.5 MB, memory at 2 GB (CPU-only), bundle size at 500 MB, and execution at 300 s — every one of which AI audio separation violates (§4.1) | 2026-11-16 |
| **D3** | Application stack | **Tauri v2 (Rust + React/TypeScript) + Python FastAPI sidecar.** Tauri delivers a native desktop GUI and OS integration; Python preserves 100% compatibility with PyTorch and `python-audio-separator` (§3.3) | 2026-11-16 |
| **D4** | Pure-Rust ML inference (`ort` / ONNX) | **Rejected in favor of the Python sidecar.** Pure Rust works for basic 4-stem HTDemucs but requires hand-implementing custom STFT/iSTFT windowing and overlap-add math for every new model architecture, locking the app out of `BS-RoFormer` | 2026-11-16 |
| **D5** | Separation models | **Two-tier model lineup:** `BS-RoFormer` for 2-stem (Vocals / Instrumental — highest SDR quality) and `htdemucs_ft` / `htdemucs_6s` for 4-stem (Vocals, Drums, Bass, Other) and 6-stem (+ Guitar, Piano) (§4.3) | 2026-11-16 |
| **D6** | Audio transfer between Python and UI | **File-path references, never raw audio bytes over HTTP.** The sidecar writes stems to a local workspace directory and returns file paths; the Tauri frontend loads them directly via Tauri's `asset://` protocol or local HTTP range streaming | 2026-11-16 |
| **D7** | Mobile access | **Local LAN Companion Mode (Phase 4, optional)** rather than cloud hosting. Toggling LAN mode binds the sidecar to `0.0.0.0` and displays a QR code so a phone on the same Wi-Fi can upload and split tracks using the PC's GPU | 2026-11-16 |

### 1.3 What "Done" Looks Like

| Capability | Success looks like |
|---|---|
| **2-Stem Vocal / Instrumental** | Drop an `.mp3` into the window; within 20–45 seconds (on GPU), play back the isolated vocal with zero noticeable drum/synth bleed — matching or beating `vocalremover.org` |
| **4-Stem / 6-Stem Split** | Pick 4-Stem or 6-Stem mode; mute *only* the guitar or drums while keeping vocals, bass, and keys playing in sample-accurate sync |
| **Real-time Mixer** | Click **S** (Solo) or **M** (Mute) or drag a stem's volume slider during playback; the audio responds immediately without stutter or desync |
| **Export** | Export an individual stem (e.g., `Vocals.mp3`) **or** export the current custom mix (e.g., "everything except drums") in one click |
| **Zero Zombie Processes** | Close the desktop window mid-inference; the Python sidecar and its CUDA memory are terminated and freed within 1 second |

---

## 2. Scope

### 2.1 In Scope

| # | Capability | Phase | Complexity |
|---|---|---|---|
| A | Environment bootstrap, Tauri v2 + Python sidecar lifecycle, health check & auto-kill | 0 | Medium |
| B | Audio ingest (drag & drop), FFmpeg pre-flight check, 2-stem & 4/6-stem inference with live progress | 1 | Medium |
| C | Multi-track DAW mixer UI (waveforms, synchronized playback, Solo/Mute, per-stem volume, seek) | 2 | **High** (keeping 4–6 decoded audio buffers in lockstep requires Web Audio API discipline) |
| D | Stem export (individual stem save + custom mixdown via FFmpeg in `.wav` / `.mp3` / `.flac`) | 2 | Low |
| E | Local job history, disk cache indicator, and one-click cache purge | 3 | Low |
| F | LAN Mobile Companion Mode (toggle `0.0.0.0` binding + QR code + lightweight mobile web UI) | 4 ⏸ **Optional** | Medium |

### 2.2 Explicitly Out of Scope

| Not doing | Why |
|---|---|
| **Hosting the backend on Vercel / Netlify / Render free tiers** | Hard technical mismatch: 4.5 MB request body limits, 2 GB RAM ceilings, no GPU, and 500 MB bundle limits make PyTorch stem separation impossible on standard serverless tiers (§4.1). |
| **Pure-Rust ONNX inference (`ort` + custom STFT)** | High engineering effort for worse model selection. Porting `Mel-Band RoFormer` or `BS-RoFormer` complex STFT windowing to Rust takes weeks and breaks whenever a better checkpoint drops. |
| **Training or fine-tuning AI models** | We are consumers of pre-trained weights (`python-audio-separator`), not training new ones. |
| **Pitch shifting, tempo changing, or chord detection** | Nice-to-have DAW features, but they bloat the audio playback graph (requiring a time-stretch DSP node per stem) before the core splitter is proven. Revisit only after Phase 2 ships. |
| **Direct Spotify / Apple Music DRM stream ripping** | Out of scope and legally fraught. The app operates strictly on local audio/video files (`.mp3`, `.wav`, `.flac`, `.m4a`, `.mp4`) already on the user's disk. |
| **Bundling a 4 GB PyTorch + CUDA runtime inside a public installer** | This is a personal/local tool first. In Phase 0–3, the Tauri app points at a local Python `.venv` rather than fighting PyInstaller + CUDA DLL packaging bloat (~3.5 GB). Standalone bundling is deferred until the app needs to run on a second PC. |

---

## 3. Architecture

### 3.1 System Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Tauri v2 Desktop Window                                                 │
│                                                                         │
│  ┌───────────────────────────────────┐    ┌──────────────────────────┐  │
│  │ React + TypeScript UI             │    │ Rust Core (src-tauri)    │  │
│  │  • Drag & drop file zone          │◄──►│  • Spawns Python sidecar │  │
│  │  • Web Audio API multi-stem mixer │    │  • Monitors process PID  │  │
│  │  • Canvas waveform renderer       │    │  • Kills tree on exit    │  │
│  │  • Solo / Mute / Volume / Seek    │    │  • Native file dialogs   │  │
│  └───────────┬───────────────────────┘    └────────────┬─────────────┘  │
└──────────────┼─────────────────────────────────────────┼────────────────┘
               │ HTTP REST + SSE (127.0.0.1:PORT)        │ Process stdio
               ▼                                         ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Python FastAPI Sidecar (sidecar/server.py)                              │
│  ├── python-audio-separator (PyTorch + ONNX Runtime)                    │
│  │     ├── BS-RoFormer (2-stem: Vocals, Instrumental)                   │
│  │     └── HTDemucs (4-stem / 6-stem)                                   │
│  ├── FFmpeg subprocess (decode input, mixdown, encode MP3/FLAC/WAV)     │
│  └── Local Workspace (~/.stemsplit/jobs/<job_id>/*.wav)                 │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Core Design Principles

1. **Zero-Copy Audio Transport:** Never base64-encode or stream multi-megabyte `.wav` stems through
   JSON responses. Python writes separated files directly to disk (`~/.stemsplit/jobs/<id>/`); the
   API returns only metadata and file paths, and the frontend reads the files straight from disk via
   Tauri's `asset://` protocol.
2. **The UI Never Blocks on Inference:** Separation takes 15 seconds to 3 minutes depending on GPU
   vs. CPU. The `/separate` endpoint returns a `job_id` immediately and runs inference in a
   background worker thread, streaming progress updates over Server-Sent Events (`/jobs/{id}/events`).
3. **Sample-Accurate Stem Sync:** Playing four `<audio>` HTML elements simultaneously via
   `.play()` will drift out of phase within seconds, causing comb-filtering when two stems share
   bleed. Playback **must** use a single shared `AudioContext` clock, or a single master transport
   controlling buffer offsets (§6.3).
4. **Hard Process Cleanup:** A desktop app that leaves a 4 GB `python.exe` holding GPU VRAM after
   the window is closed is broken. Rust owns the sidecar PID and kills the entire process tree on
   exit, crash, or reload (§5.4).
5. **Download Weights on Demand, Not on Install:** Model checkpoints are 150 MB to 800 MB each.
   Only download a model the first time the user selects it, and cache it permanently in
   `~/.stemsplit/models/`.

### 3.3 Why Tauri + Python Sidecar (and Why Not Pure Rust)

The temptation in a Tauri project is to write the entire backend in Rust using `ort` (ONNX Runtime)
and `symphonia` (audio decoding). Here is why we explicitly split the responsibilities instead:

| Concern | Pure Rust (`ort` + custom DSP) | Tauri (Rust) + Python Sidecar (`audio-separator`) |
|---|---|---|
| **Model support** | Locked to whatever you manually write pre/post-processing tensor math for (usually basic 4-stem HTDemucs) | **Immediate access to 50+ models** (`BS-RoFormer`, `Mel-Band RoFormer`, `HTDemucs_ft`, `HTDemucs_6s`, `MDX-Net`) via a single model string |
| **STFT / Overlap-Add** | Must hand-port complex windowing, padding, and chunking per architecture; a 1-sample offset ruins phase cancellation | Handled upstream and battle-tested by the UVR / `audio-separator` community |
| **CUDA setup** | Finicky `cudnn` / `onnxruntime` dynamic library linking on Windows | Standard `pip install torch` + `audio-separator[gpu]` inside a `.venv` |
| **UI & OS ergonomics** | Native window, tiny shell | **Identical** — Tauri still provides the window, native drag-and-drop, file dialogs, and process management |

**Verdict:** Rust does what Rust is best at (windowing, OS file system, process supervision); Python
does what Python is best at (PyTorch GPU inference).

### 3.4 File & Folder Structure

```
stemsplit/
│
├── TECHNICAL_DESIGN.md         <- This document
├── AGENTS.md                   <- Instructions & conventions for Antigravity IDE agents
├── package.json                <- Frontend dependencies (React, Web Audio API, Lucide)
├── vite.config.ts              <- Vite bundler config for Tauri frontend
│
├── src/                        <- Frontend (React + TypeScript)
│   ├── main.tsx                <- Entry point
│   ├── App.tsx                 <- Top-level state machine (Idle → Processing → Mixer)
│   ├── styles/
│   │   └── tokens.css          <- Dark-mode DAW design tokens & layout rules
│   ├── lib/
│   │   ├── sidecar.ts          <- Typed client for FastAPI REST + SSE progress stream
│   │   └── audio-engine.ts     <- Web Audio API synchronized multi-stem player
│   └── components/
│       ├── DropZone.tsx        <- File ingest, model selector (2/4/6 stem), pre-flight status
│       ├── ProgressPanel.tsx   <- Live stage + percentage bar + cancel button
│       ├── MixerView.tsx       <- Master transport + stem rows (waveform, S, M, volume)
│       ├── ExportModal.tsx     <- Individual stem save + custom mixdown dialog
│       └── HistorySidebar.tsx  <- Past jobs & cache cleanup (Phase 3)
│
├── src-tauri/                  <- Rust Desktop Core (Tauri v2)
│   ├── Cargo.toml
│   ├── tauri.conf.json         <- Window config, asset protocol scope
│   ├── capabilities/
│   │   └── default.json        <- Tauri v2 capability permissions (asset scope, dialogs, opener)
│   └── src/
│       ├── main.rs
│       ├── lib.rs              <- Tauri commands (get_sidecar_port, open_folder, etc.)
│       └── sidecar.rs          <- Spawns Python .venv server, health check, kill-on-exit
│
└── sidecar/                    <- Python Inference Backend
    ├── requirements.txt        <- fastapi, uvicorn, audio-separator[gpu], pydantic
    ├── server.py               <- FastAPI endpoints (/health, /models, /separate, /jobs, /export)
    ├── worker.py               <- Background inference runner + progress callback hook
    └── ffmpeg_utils.py         <- Probe duration, custom mixdown, MP3/FLAC/WAV encoding
```

### 3.5 Environments & Packaging

Because this tool is built primarily for **personal local use** (with Antigravity IDE on the same
machine), we avoid the trap of spending days fighting PyInstaller before writing a line of UI:

`sidecar/.venv` **must** be created using **Python 3.11 (64-bit)** (`py -3.11 -m venv sidecar/.venv`)
rather than Python 3.13 so prebuilt Windows wheels for PyTorch CUDA, `onnxruntime-gpu`, and
`audio-separator[gpu]` install cleanly without native C-extension build failures.

| Mode | How the Python Sidecar Runs | When to Use |
|---|---|---|
| **Dev (`npm run tauri dev`)** | Rust spawns `sidecar/.venv/Scripts/python.exe -m uvicorn server:app` directly | Daily development & personal use on your main PC |
| **Local Release Build (`npm run tauri build`)** | Compiled `.exe` launcher still points at `~/.stemsplit/venv` (or project `.venv`) | Fast desktop shortcut without terminal windows (`CREATE_NO_WINDOW` flag on Windows) |
| **Standalone Portable Bundle (Optional, later)** | PyInstaller `--onedir` packaged as a Tauri `externalBin` | Only if you ever distribute the app to someone else's machine |

> **As built (2026-11-16):**
> - **Drive `D:` storage layout:** Because drive `C:` had minimal headroom, toolchains and caches
>   were placed on `D:` (`D:\Programs\rust\.rustup`, `D:\Programs\rust\.cargo`,
>   `D:\Programs\ffmpeg\bin`, project `.cache/*`) and `~/.stemsplit` (`C:\Users\ovlim\.stemsplit`)
>   was created as an NTFS directory junction to `D:\.stemsplit`.
> - **CUDA 12 wheel alignment:** `onnxruntime-gpu==1.23.2` is pinned alongside `torch==2.5.1+cu121`
>   in `sidecar/requirements.txt` (newer `onnxruntime-gpu 1.32.x` builds target CUDA 13 and emit
>   missing `cublasLt64_13.dll` warnings against PyTorch's CUDA 12.1 runtime).

---

## 4. Platform & ML Stack

### 4.1 Why Vercel & Free Cloud Hosting Were Rejected

Recording the exact limits here so we never revisit "why not just deploy the Python script to
Vercel":

1. **4.5 MB Request Body Limit:** A typical 4-minute `.mp3` (8–12 MB) or `.wav` (40 MB) uploaded to
   a Vercel Serverless Function is rejected at the edge with `413 FUNCTION_PAYLOAD_TOO_LARGE`.
2. **2 GB Memory Ceiling & No GPU:** Vercel Hobby functions run on shared CPU with a 2 GB RAM cap.
   Loading PyTorch + `BS-RoFormer` weights + STFT tensors for a 4-minute song peaks at 2.8–4.5 GB
   of RAM, crashing the container immediately with an Out-of-Memory (OOM) error.
3. **500 MB Bundle Size & 300s Timeout:** PyTorch and audio libraries exceed serverless bundle
   caps, and CPU-only RoFormer inference on a full song frequently exceeds 5 minutes.

Running locally on your own GPU costs **Rp 0**, has **no file size cap**, and finishes a track in
seconds instead of timing out.

### 4.2 Inference Engine — `python-audio-separator`

We wrap **`audio-separator`** (the Python library extracted from the Ultimate Vocal Remover / UVR
project) rather than calling `demucs` or `torch` directly. Why:

- **One API for multiple architectures:** Switching between `BS-RoFormer` (MDX/RoFormer family) and
  `htdemucs_ft` (Demucs family) is a single filename change in `separator.load_model()`.
- **Built-in chunking & FP16:** Exposes `use_autocast=True` and `segment_size` / chunk parameters to
  prevent VRAM Out-of-Memory errors on consumer GPUs.
- **Automatic weight downloading:** Downloads missing `.ckpt` / `.yaml` / `.th` files from official
  releases into `model_file_dir` automatically.

### 4.3 Model Lineup: BS-RoFormer vs. HTDemucs

No single AI model is best at both 2-stem vocal isolation and 4/6-stem instrument splitting. The
app exposes **three curated presets** rather than dumping 60 cryptic checkpoint filenames on the
user:

| Preset Name in UI | Underlying Model File | Stems Produced | Why It's Here |
|---|---|---|---|
| **Vocals & Instrumental (Best Quality)** | `model_bs_roformer_ep_317_sdr_12.9755.ckpt` | `Vocals`, `Instrumental` | **Default.** State-of-the-art Signal-to-Distortion Ratio ($\text{SDR} \approx 12.97\text{ dB}$). Noticeably cleaner vocal isolation and less metallic reverb bleed than Demucs. |
| **4-Stem Band Split** | `htdemucs_ft.yaml` | `Vocals`, `Drums`, `Bass`, `Other` | Meta's fine-tuned Hybrid Transformer Demucs. Best balance of speed and separation when you want to mute drums or bass specifically. |
| **6-Stem Full Split (+ Guitar & Piano)** | `htdemucs_6s.yaml` | `Vocals`, `Drums`, `Bass`, `Guitar`, `Piano`, `Other` | Adds dedicated `Guitar` and `Piano` stems. **Caveat noted in UI:** the `Guitar` and `Piano` stems have slightly more bleed between each other than the 4-stem model; use only when isolating guitar/keys is the goal. |

### 4.4 Hardware, CUDA & VRAM Constraints

| Hardware Tier | Expected Speed (4-min song) | Required Settings |
|---|---|---|
| **NVIDIA GPU ($\ge 6\text{ GB}$ VRAM)** | ~15–25s (Demucs) · ~25–45s (BS-RoFormer) | `use_autocast=True` (FP16), default batch/segment size |
| **NVIDIA GPU ($4\text{ GB}$ VRAM — Verified Target: RTX 3050 Laptop `4096 MiB`, Driver `617.42`)** | ~30–60s | `use_autocast=True` (FP16) + conservative 4 GB segment defaults (`mdxc_params` & `demucs_params` below) + `torch.cuda.empty_cache()` between runs to avoid CUDA OOM |
| **Apple Silicon (M1/M2/M3 MPS) or CPU** | ~2–5 mins | Automatic fallback when `torch.cuda.is_available()` is false; UI shows a "Running on CPU — this may take a few minutes" notice |

**Mandatory `Separator` constructor defaults in `worker.py` (4 GB VRAM baseline):**

- `use_autocast=True` whenever `torch.cuda.is_available()` is `True` (FP16 half-precision).
- `mdxc_params={"segment_size": 256, "override_model_segment_size": False, "batch_size": 1, "overlap": 4}` for `BS-RoFormer`.
- `demucs_params={"segments_enabled": True, "shifts": 1, "overlap": 0.25}` for `HTDemucs`.

> ⚠️ **Model hot-swapping leaks VRAM if not cleared.** When a user runs a 2-stem `BS-RoFormer` split
> and then immediately switches to `htdemucs_ft`, keeping both models resident in VRAM will OOM a
> 4–6 GB card. The worker **must** keep at most **one** `Separator` model loaded at a time,
> explicitly deleting the old instance and calling `gc.collect()` + `torch.cuda.empty_cache()`
> before loading a different preset.

---

## 5. Data & IPC Contract

### 5.1 Overview

There is **no SQL database**. State is small, local, and file-backed:

```
~/.stemsplit/
├── config.json                 <- Last used preset, export format, output folder, LAN toggle
├── models/                     <- Cached .ckpt / .yaml / .th weights (downloaded once)
└── jobs/
    └── <job_id>/               <- One folder per separated track
        ├── manifest.json       <- Job metadata, source filename, preset, duration, stem paths
        ├── original.wav        <- Normalized 44.1 kHz stereo input (for A/B comparison)
        ├── Vocals.wav
        ├── Drums.wav
        ├── Bass.wav
        └── Other.wav
```

**Why `manifest.json` per folder instead of SQLite:** Deleting a folder in Windows Explorer
cleanly deletes the job; there is no database index to go out of sync with the filesystem.

### 5.2 Job State Machine & Local Storage

Every separation request moves through a strict state machine:

```
queued ──► probing ──► loading_model ──► separating (0–100%) ──► finalizing ──► completed
                                                                            ├──► failed
                                                                            └──► cancelled
```

**`manifest.json` schema:**

```json
{
  "id": "job_20261116_0142_a8f9",
  "created_at": "2026-11-16T01:42:10Z",
  "source_name": "Bring Me The Horizon - Drown.mp3",
  "duration_sec": 222.4,
  "sample_rate": 44100,
  "preset": "roformer_2stem",
  "status": "completed",
  "original_path": "C:/Users/.../.stemsplit/jobs/job_20261116_0142_a8f9/original.wav",
  "stems": [
    { "id": "vocals", "label": "Vocals", "color": "#2dd4bf", "path": "C:/Users/.../Vocals.wav" },
    { "id": "instrumental", "label": "Instrumental", "color": "#f59e0b", "path": "C:/Users/.../Instrumental.wav" }
  ]
}
```

### 5.3 Sidecar API Specification

The Python FastAPI sidecar binds to `127.0.0.1` on an available port (default `18420`, passed to
the frontend via a Tauri command) and exposes ten endpoints:

| Method & Path | Purpose | Payload / Response |
|---|---|---|
| `GET /health` | Startup readiness + hardware probe | Returns `{ status: "ok", device: "cuda" \| "mps" \| "cpu", gpu_name: "NVIDIA RTX ...", ffmpeg_ok: true }` |
| `GET /models` | Lists the 3 curated presets + whether each weight file is already cached on disk | Array of `{ id, label, stems_count, size_mb, is_downloaded }` |
| `POST /separate` | Starts a separation job asynchronously | Input: `{ file_path, preset_id }`. Returns `{ job_id }` (`202 Accepted`) immediately |
| `GET /jobs/{id}/events` | **Server-Sent Events (SSE)** stream of real-time progress | Streams `{ stage, percent, message }` until `completed`, `cancelled`, or `failed` |
| `POST /jobs/{id}/cancel` | Aborts an in-flight separation job | Sets the job's `cancel_event` (`threading.Event`) so `TqdmToSSE` unwinds inference cleanly and removes partial files |
| `GET /jobs` | Lists cached separation jobs for the History drawer (Phase 3) | Returns `{ jobs: [...], total_cache_bytes }` with `manifest.json` summaries sorted newest-first |
| `GET /jobs/{id}` | Fetches full metadata for a completed or past job | Returns the complete `manifest.json` object for `{id}` |
| `DELETE /jobs/{id}` | Removes a single cached job folder from `~/.stemsplit/jobs/{id}/` | Deletes the directory and returns `{ deleted_id, total_cache_bytes }` |
| `DELETE /jobs` | Purges all cached jobs in `~/.stemsplit/jobs/` | Deletes all job directories and returns `{ total_cache_bytes: 0 }` |
| `POST /export` | Renders a single stem or custom mixdown via FFmpeg | Input: `{ job_id, target_path, format: "mp3" \| "wav" \| "flac", stems: [{ id, volume, muted }] }`. Returns `{ saved_path, bytes }` |

> **Why SSE instead of WebSockets for progress:** Progress is strictly one-way (Python → UI). SSE
> works over standard HTTP via `EventSource`, reconnects automatically, and requires zero extra
> framing logic.

### 5.4 Process Lifecycle & Security Model

- **Localhost-only by default:** Unless LAN Companion Mode (§6.6) is explicitly switched on by the
  user, FastAPI binds to `127.0.0.1`, making it unreachable from other machines on the network.
- **No zombie Python processes on Windows:** In `src-tauri/src/sidecar.rs`, the Python process is
  spawned with `CREATE_NO_WINDOW` (`0x08000000`) so no black console window flashes on startup.
  When the Tauri app receives `RunEvent::Exit` or `WindowEvent::Destroyed`, Rust invokes `taskkill
  /F /T /PID <sidecar_pid>` (on Windows) or `kill -TERM -<pgid>` (on macOS/Linux) to kill both the
  `uvicorn` wrapper **and** any child PyTorch/FFmpeg subprocesses.
- **Tauri v2 `asset://` scope & capabilities:** Enable the `protocol-asset` Cargo feature on `tauri`
  (alongside `tauri-plugin-dialog` and `tauri-plugin-opener`), configure `assetProtocol` in
  `tauri.conf.json` strictly for `$HOME/.stemsplit/jobs/**` plus user-selected files, and declare
  runtime permissions in `src-tauri/capabilities/default.json`.

> **As built (2026-11-16):**
> - **GNU target linking in `src-tauri/Cargo.toml`:** Rust compiles via `x86_64-pc-windows-gnu`
>   (using `C:\msys64\mingw64\bin`) with `crate-type = ["rlib"]` under `[lib]`. Omitting
>   `cdylib`/`staticlib` (which are only required for mobile targets) avoids exceeding the Windows
>   PE 65,535 export ordinal limit on GNU `ld.exe` (`export ordinal too large`).
> - **`assetProtocol` junction scope:** `tauri.conf.json` permits both `$HOME/.stemsplit/**` and
>   `D:/.stemsplit/**` so junction-resolved paths remain accessible to the WebView asset protocol.

---

## 6. Feature Specifications

### 6.1 (A) Audio Ingest & FFmpeg Pre-Flight — Phase 1

**Startup Pre-Flight:**
On launch, the UI calls `GET /health`. If `ffmpeg_ok` is `false`, a clear blocking banner explains
how to install FFmpeg (`winget install Gyan.FFmpeg` on Windows) with a "Cek Lagi" button — rather
than letting the user drop a file and fail mid-separation with a cryptic Python `FileNotFoundError`.
The top bar also displays a hardware badge (`🟢 GPU: RTX 4060 (CUDA)` or `🟡 CPU Mode`).

**Ingest:**
- Drag-and-drop anywhere on the dropzone, or click to open the native Tauri file dialog.
- **Accepted formats:** `.mp3`, `.wav`, `.flac`, `.m4a`, `.aac`, `.ogg`, plus video files (`.mp4`,
  `.mkv`, `.mov` — FFmpeg strips the audio track automatically, which is huge for splitting music
  videos or screen recordings).
- **Duration sanity check:** `ffprobe` reads the file duration before loading PyTorch. Files over
  15 minutes trigger a confirmation dialog warning about processing time and RAM usage in the mixer.

### 6.2 (B) AI Separation Pipeline & Model Manager — Phase 1

**Workflow:**
1. User selects a file and picks one of the 3 presets (§4.3):
   - **2 Stems:** *Vocals + Instrumental* (`BS-RoFormer`)
   - **4 Stems:** *Vocals + Drums + Bass + Other* (`HTDemucs Fine-Tuned`)
   - **6 Stems:** *Vocals + Drums + Bass + Guitar + Piano + Other* (`HTDemucs 6-Stem`)
2. If the chosen preset's weights are not yet in `~/.stemsplit/models/`, the UI shows a one-time
   "Downloading model weights (~320 MB)…" step before inference starts.
3. The worker first normalizes the user's input via `ffmpeg` to
   `~/.stemsplit/jobs/<id>/original.wav` (`44100 Hz`, stereo), and passes **only `original.wav`**
   (never the raw user filename) into `Separator.separate()`. This guarantees predictable
   `original_(<Stem>)_<model>.wav` outputs immune to parentheses or special characters in song
   titles, which are immediately renamed into canonical names (`Vocals.wav`, `Instrumental.wav`,
   `Drums.wav`, `Bass.wav`, `Guitar.wav`, `Piano.wav`, `Other.wav`).
4. **Live progress capture & cooperative cancellation:** `python-audio-separator` uses `tqdm` for
   chunk progress. Our custom `TqdmToSSE` stream wrapper intercepts `tqdm` updates and pushes
   `{ stage: "separating", percent: 0..100 }` over the SSE channel so the UI progress bar moves
   smoothly instead of sitting at an indeterminate spinner. On every `tqdm` update tick, `TqdmToSSE`
   also checks the job's `threading.Event` (`cancel_event`) and raises `JobCancelledError` when
   cancelled — unwinding `Separator.separate()` at the next chunk boundary (~$0.5\text{--}1.5\text{ s}$),
   running `gc.collect()` + `torch.cuda.empty_cache()`, and cleaning up partial files without
   restarting the FastAPI server.

> **As built (2026-11-16):**
> - **Pre-flight probe endpoint:** Added `POST /probe` in `sidecar/server.py` so `DropZone.tsx`
>   validates media streams and reads duration/sample rate/channels via `ffprobe` immediately on
>   drop or file selection (triggering the `> 15 min` confirmation check before queueing).
> - **Model instance `output_dir` synchronization:** `audio-separator` 0.48.0 copies `output_dir`
>   onto `separator.model_instance` during `load_model()`. When reusing the loaded `Separator`
>   across consecutive jobs, `ModelManager.prepare_separator()` updates both `separator.output_dir`
>   and `separator.model_instance.output_dir` to the new `job_dir`.
> - **`TqdmToSSE` & Windows encoding safety:** `TqdmToSSE` wraps `sys.stderr` with `encoding="utf-8"`
>   and `isatty() -> True`, coalescing percentage updates and scaling across `total_passes = 4`
>   for `htdemucs_ft` (`BagOfModels`) without forwarding `tqdm`'s Unicode block characters to
>   `cp1252` Windows consoles.
> - **Observed weight size & CUDA behavior:** `model_bs_roformer_ep_317_sdr_12.9755.ckpt` weighs
>   `609.7 MB` on disk and runs cleanly with `use_autocast=True` and `use_soundfile=True` on the
>   RTX 3050 Laptop GPU (`4095 MiB` VRAM).

### 6.3 (C) Multi-Track DAW Mixer & Synchronized Playback — Phase 2

Once separation finishes, the screen transitions into the **Mixer View** — modeled directly on
`vocalremover.org` and BandLab Splitter, upgraded for desktop ergonomics:

```
┌─────────────────────────────────────────────────────────────────────────┐
│ [◄ Back]  Bring Me The Horizon - Drown.mp3        [🟢 CUDA] [Export ▼]  │
├─────────────────────────────────────────────────────────────────────────┤
│  [ ▶ Play ]  01:14.2 / 03:42.4   [ ⏮ ] [ 🔁 Loop ]    Master: [━━●━━]  │
├───────────┬─────────┬────────────┬──────────────────────────────────────┤
│ Vocals    │ [S] [M] │ ━━━●━ 100% │ ▂▃▅▇█▅▃▂▁▁▂▄▆█▆▃▂▁▂▃▅▆▄▂▁ (Teal)     │
├───────────┼─────────┼────────────┼──────────────────────────────────────┤
│ Drums     │ [S] [M] │ ●━━━━   0% │ ▅▇▃▅▇▅▃▅▇▅▃▅▇▅▃▅▇▅▃▅▇▅▃▅ (Muted)    │
├───────────┼─────────┼────────────┼──────────────────────────────────────┤
│ Bass      │ [S] [M] │ ━━━●━ 100% │ ▃▄▅▄▃▄▅▆▅▄▃▄▅▄▃▄▅▆▅▄▃▄▅▄▃ (Amber)    │
├───────────┼─────────┼────────────┼──────────────────────────────────────┤
│ Other     │ [S] [M] │ ━━●━━  80% │ ▂▃▄▆▄▃▂▃▄▅▄▃▂▃▄▆▄▃▂▃▄▅▄▃▂ (Purple)   │
└───────────┴─────────┴────────────┴──────────────────────────────────────┘
```

**Technical requirements for the audio engine (`src/lib/audio-engine.ts`):**

| Requirement | Implementation Detail |
|---|---|
| **Zero-drift synchronization** | All stems and `original.wav` (`manifest.original_path`) are decoded into `AudioBuffer` objects under a single `AudioContext`. Pressing Play creates an `AudioBufferSourceNode` for every stem plus `original.wav` and starts all of them at the exact same hardware timestamp (`ctx.currentTime + 0.02`) at the same `offset`. **Never use separate HTML `<audio>` elements without a shared Web Audio clock** — even a 5 ms drift between stems creates an audible phaser/flanger artifact on shared frequencies. |
| **Instant Solo / Mute / Volume & `A/B Original`** | Each stem's `AudioBufferSourceNode` routes through its own `GainNode` before hitting the master `GainNode`; `original.wav` routes through a parallel `originalGainNode` (default `0`). Muting sets a stem's gain to $0$ via `gain.setTargetAtTime(0, ctx.currentTime, 0.01)` (a 10 ms ramp prevents audible click/pop artifacts). Soloing mutes all non-soloed stems while preserving their fader positions. Toggling **A/B Original** ON ramps `originalGainNode` to `1.0` and all stem `GainNode`s to `0.0` via the same 10 ms `setTargetAtTime` ramp; toggling OFF restores each stem's effective gain cleanly with zero seek lag or phase drift. |
| **Waveform rendering** | On load, a single pass computes peak min/max buckets (e.g., 1,200 bars across the track width) from each `AudioBuffer.getChannelData(0)` and draws them to a lightweight `<canvas>` per row. Clicking anywhere on any waveform seeks the master transport to that timestamp. |
| **Memory ceiling guard** | Decoding six 5-minute 44.1 kHz 32-bit float stereo buffers into RAM takes $\approx 6 \times 5 \times 60 \times 44100 \times 2 \times 4\text{ bytes} \approx 635\text{ MB}$ — completely fine on desktop. For tracks over 10 minutes, downmix waveform peak analysis and dispose buffers immediately (`audioBuffer = null`) when switching jobs so RAM never accumulates across songs. |

> **As built (2026-11-16):**
> - **Playback session guard on `onended`:** `MultiStemAudioEngine` increments a `playbackSessionId`
>   counter whenever sources are stopped or re-seeded during `pause()`/`seek()` so asynchronous
>   `AudioBufferSourceNode.onended` callbacks from superseded sources never reset the transport
>   when scrubbing or looping.
> - **HiDPI `<canvas>` waveforms & pointer scrubbing:** `StemWaveformCanvas` observes container size
>   via `ResizeObserver`, scales canvas backing bitmaps by `window.devicePixelRatio`, caches
>   `1,200`-bucket min/max `Float32Array` peaks once on decode, and supports click-and-drag pointer
>   capture scrubbing across any stem row.

### 6.4 (D) Stem Export & Custom Mixdown — Phase 2

Clicking **Export** offers two distinct modes so you don't need an external DAW just to bounce a
backing track:

1. **Save Individual Stems:**
   - One-click save for any single stem (e.g., *Vocals only* or *Instrumental only*), or **Export
     All Stems as ZIP / Folder**.
2. **Save Custom Mix ("What You Hear"):**
   - Uses the current mixer state (Solo, Mute, and Volume fader percentages).
   - Example: To remove *only* the drums and guitar from a song, mute `Drums` and `Guitar` in the
     mixer, then click **Export Current Mix**.
   - The sidecar runs FFmpeg with the exact linear weights of the active stems using
     `amix=inputs=N:duration=longest:dropout_transition=0:weights='...':normalize=0,alimiter=limit=0.99:level=disabled`
     — setting `normalize=0` prevents FFmpeg's default $1/N$ amplitude attenuation (which otherwise
     drops mix volume by $6\text{--}12\text{ dB}$), while `alimiter` guards against digital clipping
     when stems are boosted up to $150\%$ — and encodes the output to the user's chosen format:
     - **MP3 (`320 kbps` CBR)** — small, ready for phone/sharing
     - **WAV (`16-bit` or `24-bit` PCM)** — lossless for editing
     - **FLAC** — lossless compressed

> **As built (2026-11-16):**
> - **Unified export modes in `POST /export`:** `ExportRequest` accepts `mode`
>   (`custom_mix`, `single_stem`, `all_stems_folder`, `all_stems_zip`) alongside `stems: [{ id, volume, muted, soloed }]`
>   so custom mixes preserve exact Solo/Mute/fader logic and batch `.zip` exports stage temporary
>   encoded stems alongside `target_path` (avoiding `C:` temp usage).

### 6.5 (E) Job History & Cache Management — Phase 3

- A collapsible left drawer lists previously separated songs read from `~/.stemsplit/jobs/*/manifest.json`.
- Clicking a past song loads its stems straight into the mixer in $< 1\text{ second}$ without
  re-running the AI model.
- Footer of the drawer shows total disk usage (e.g., `Cache: 1.4 GB across 8 songs`) with a
  per-song delete icon and a **"Bersihkan Semua Cache"** button.

### 6.6 (F) LAN Mobile Companion Mode — Phase 4 ⏸ Optional

Because the original use case started on a phone, Phase 4 brings that capability back **without**
paying for cloud GPUs:

- A toggle in the desktop top bar (**"Mode HP (Wi-Fi)"**) restarts or binds an auxiliary FastAPI
  listener on `0.0.0.0:7860` and detects the PC's local LAN IP (e.g., `http://192.168.1.15:7860`).
- Clicking the badge pops up a **QR code modal** on the desktop screen.
- Scanning the QR code with an iPhone on the same Wi-Fi opens a lightweight, mobile-responsive
  HTML page served directly by the Python sidecar:
  - Upload a song from iPhone **Files**
  - Watch the PC's GPU split it in 25 seconds
  - Toggle checkboxes for which stems to keep (e.g., uncheck *Drums* and *Guitar*)
  - Tap **Download Mix** to save the resulting `.mp3` straight back to the iPhone.

---

## 7. Desktop UI & Design System

### 7.1 Visual Language & Tokens

Designed as a clean, dark-mode studio utility (inspired by `vocalremover.org` and Ableton/Logic
strip ergonomics):

```css
:root {
  /* Surfaces */
  --bg-app:        #0f1115;   /* main window background */
  --bg-panel:      #171a21;   /* mixer track row & cards */
  --bg-elevated:   #212631;   /* modals, dropdowns, hover states */
  --border-subtle: rgba(255, 255, 255, 0.08);

  /* Text */
  --text-primary:  #f3f4f6;
  --text-muted:    #9ca3af;

  /* Stem Accent Palette (consistent per stem type) */
  --stem-vocals:   #2dd4bf;   /* Teal */
  --stem-inst:     #f59e0b;   /* Amber */
  --stem-drums:    #f43f5e;   /* Rose */
  --stem-bass:     #3b82f6;   /* Blue */
  --stem-guitar:   #a855f7;   /* Purple */
  --stem-piano:    #10b981;   /* Emerald */
  --stem-other:    #eab308;   /* Yellow */
}
```

### 7.2 Screen Layout

Single-window application (`min-width: 900px`, `min-height: 600px`, default `1120 × 720`). No
scrolling page — the window is a fixed viewport (`100vh`) with internal scroll only on the stem
list (when 6 stems are visible on a small laptop screen) and the history drawer.

### 7.3 Mixer Ergonomics & Keyboard Shortcuts

| Key / Gesture | Action |
|---|---|
| `Space` | Play / Pause master transport |
| `Click` on waveform | Seek all stems to that exact position |
| `1` – `6` | Toggle Solo on stem row $1\dots6$ |
| `Double-click` volume slider | Reset stem volume to $100\%$ ($0\text{ dB}$) |
| `Ctrl/Cmd + E` | Open Export modal |

---

## 8. Cost & Resource Analysis

### 8.1 One-Time Development Effort

Estimated assuming development in **Google Antigravity IDE** with agentic scaffolding:

| Phase | Work | Effort |
|---|---|---|
| **0 — Foundation** | Python `.venv` + CUDA + `audio-separator` + FFmpeg check, Tauri v2 scaffold, Rust sidecar spawner/killer, `/health` handshake | **0.5–1 day** |
| **1 — Separation Core** | `/separate` endpoint, `TqdmToSSE` progress stream, file dropzone, preset selector, output file normalization | **1–1.5 days** |
| **2 — DAW Mixer & Export** | Web Audio API synchronized player, canvas waveforms, Solo/Mute/Volume ramps, FFmpeg `/export` (stems + custom mixdown) | **1.5–2.5 days** |
| **3 — History & Cache** | `manifest.json` reader, history sidebar, cache size calculator & purge | **0.5 day** |
| **4 — LAN Mobile Mode** ⏸ | `0.0.0.0` listener toggle, QR code generator, mobile HTML companion page | **0.5–1 day** |
| | **Total (Phases 0–3 — complete desktop app)** | **3.5–5.5 days** |

### 8.2 Recurring Cost

| Item | Monthly Cost | Notes |
|---|---|---|
| Cloud hosting / GPU | **Rp 0 ($0)** | Runs 100% on local hardware |
| Model weights | **Rp 0 ($0)** | Open-source (`BS-RoFormer`, Meta `HTDemucs`) |
| Subscription / per-song fees | **Rp 0 ($0)** | Unlimited splits |

### 8.3 Disk & Memory Footprint

| Resource | Size | Mitigation |
|---|---|---|
| Python `.venv` (PyTorch + CUDA + `audio-separator`) | ~3.2–4.0 GB on disk | Lives in one `.venv`; never duplicated |
| Model weights (`~/.stemsplit/models/`) | ~320 MB (`BS-RoFormer`) + ~320 MB (`htdemucs_ft`) | Downloaded lazily on first use |
| Per-song job cache (`~/.stemsplit/jobs/<id>/`) | ~150–250 MB per 4-min song (uncompressed `.wav` stems) | Phase 3 cache indicator + one-click purge keeps disk usage visible |

---

## 9. Roadmap & Back-Out Criteria

### 9.1 Principles

1. **Prove the audio quality before building the UI.** Phase 0 verifies that `audio-separator` runs
   on your GPU and produces clean stems from the CLI before a single React component is written.
2. **Every phase ships a usable tool.** After Phase 1 you already have a working desktop splitter
   that outputs files to a folder; Phase 2 adds the interactive mixer on top.
3. **Keep the sidecar decoupled.** The Python FastAPI server can be tested with `curl` or a browser
   independently of Tauri.

### 9.2 Phases

| Phase | Delivers | Effort |
|---|---|---|
| **0 — Foundation** | Python environment verified on GPU, FastAPI `/health` live, Tauri v2 window spawning and cleanly killing the Python sidecar. | 0.5–1 day |
| **1 — Separation Core** | Drag-and-drop a song, pick 2/4/6-stem preset, watch real-time progress bar, open output folder with separated `.wav` files. | 1–1.5 days |
| **2 — DAW Mixer & Export** | In-app waveform rendering, sample-accurate multi-stem playback, Solo/Mute/Volume sliders, custom mixdown export to `.mp3`/`.wav`. | 1.5–2.5 days |
| **3 — History & Cache** | Reopen previously split songs instantly from sidebar; view and clear cached `.wav` folders. | 0.5 day |
| **4 — LAN Mobile Mode** ⏸ | Scan a QR code on the desktop app to upload, split, and download stems from a phone over home Wi-Fi. | 0.5–1 day |

### 9.3 Sequencing Notes

- **Phase 0 is a hard gate.** If CUDA / FFmpeg isn't detected properly in Python, nothing above it
  works. Run `audio-separator --env_info` before scaffolding Tauri.
- **Phase 2 is the UX payoff.** Phase 1 alone replaces a CLI command; Phase 2 is what replaces
  `vocalremover.org` and BandLab.

### 9.4 Back-Out Criteria — When to Stop

| After phase | ✅ Continue if | 🛑 **Stop or pivot if** | What you keep if you stop |
|---|---|---|---|
| **0** | `audio-separator` detects your GPU (or runs at acceptable speed on CPU) and Tauri spawns/kills the sidecar cleanly | Local hardware takes $> 10\text{ minutes}$ per song on CPU and has no discrete GPU | Working Python CLI environment; can pivot to a free Google Colab / Modal notebook instead |
| **1** | Separated stems sound as clean as `vocalremover.org` and progress streams smoothly to the window | You only ever want raw `.wav` files in a folder and already mix them in an external DAW (FL Studio, Reaper, Ableton) | A complete, working desktop batch-splitter app — no need to build the Phase 2 mixer if you already use a DAW |
| **2** | Mixer plays 4–6 stems with zero drift and exports custom mixes cleanly | — (This is the primary finish line) | Complete desktop application |

---

## 10. Risks & Mitigations

| # | Risk | Likelihood | Impact | Mitigation | Caught by |
|---|---|---|---|---|---|
| **R1** | **Zombie Python process holds GPU VRAM after app closes** | **High on Windows if unmitigated** (`Child::kill()` in Rust only kills the parent wrapper, not child workers) | 2–4 GB of VRAM stays locked until the user opens Task Manager | Use `taskkill /F /T /PID <pid>` on Windows (kills entire process tree) inside Tauri's `RunEvent::Exit` hook, plus a parent-PID heartbeat check inside Python that self-exits if the Tauri parent dies | Phase 0 build test |
| **R2** | **CUDA Out-of-Memory (OOM) on 4–6 GB GPUs** during `BS-RoFormer` inference | Medium | Separation crashes mid-song | Enable `use_autocast=True` (FP16 half-precision) by default, unload previous model before loading a new one, and catch `torch.cuda.OutOfMemoryError` to auto-retry with a smaller chunk/segment size | Phase 1 test |
| **R3** | **Multi-stem playback drifts out of sync** when seeking or playing | **High if implemented with `<audio>` tags** | Audible phase cancellation / comb-filtering across stems | Use a single Web Audio API `AudioContext` and start all `AudioBufferSourceNode` instances at the exact same `ctx.currentTime` offset (§6.3) | Phase 2 build |
| **R4** | **First-run freeze while downloading 320 MB model weights** | High on first run of each preset | User thinks the app hung at $0\%$ | `/models` reports `is_downloaded: false`; UI explicitly shows a "Downloading AI model (one-time)…" state before inference starts | Phase 1 build |
| **R5** | **Uncompressed `.wav` cache silently fills 20+ GB of disk** | Medium over weeks of use | Disk space exhaustion | Store all jobs in `~/.stemsplit/jobs/`, display total cache size in the UI footer, and provide a one-click "Clear Cache" button (§6.5) | Phase 3 build |
| **R6** | **FFmpeg missing on the host machine** | Medium | Non-WAV files (`.mp3`, `.m4a`, `.mp4`) fail to load or export | `/health` runs `shutil.which("ffmpeg")` on startup; UI shows a clear install guide if missing (§6.1) | Phase 0 startup check |
| **R7** | **Port collision on `127.0.0.1:18420`** | Low | Sidecar fails to bind on launch | Rust binds a TCP listener to port `0` first to ask the OS for a guaranteed free port, closes it, and passes `--port <PORT>` to the Python sidecar | Phase 0 build |

---

## 11. Remaining Open Decisions

All initial architecture and UX decisions below are resolved; Phase 0 is cleared to start.

| # | Decision | Options | Outcome | Status |
|---|---|---|---|---|
| **D-a** | **Local GPU hardware check** | NVIDIA CUDA / Apple Silicon MPS / CPU-only | **NVIDIA CUDA (`RTX 3050 Laptop`, `4096 MiB` VRAM, Driver `617.42`) verified.** Lock in `use_autocast=True` (FP16) plus conservative 4 GB segment defaults (`mdxc_params` / `demucs_params` in §4.4) | ✅ Decided (2026-11-16) |
| **D-b** | **Waveform rendering approach** | `WaveSurfer.js` (multi-track plugin) vs. Custom Web Audio `AudioContext` + `<canvas>` | **Custom Web Audio `AudioContext` + `<canvas>` (~150 lines of TS).** Single shared `AudioContext` with one `AudioBufferSourceNode` per stem guarantees sample-accurate sync and click-free `GainNode` ramping | ✅ Decided (2026-11-16) |
| **D-c** | **Default export format** | `.mp3` (`320 kbps`) / `.wav` (`16-bit`) / `.flac` | **`.mp3` (`320 kbps` CBR) as the default** in the Export modal, with `.wav` and `.flac` one click away in a format pill selector | ✅ Decided (2026-11-16) |
| **D-d** | **Original track A/B toggle in mixer** | Include an "Original" toggle button in the transport bar vs. stems only | **Included.** `original.wav` (`manifest.original_path`) plays in parallel through `originalGainNode` inside the shared `AudioContext` for instant, phase-locked **A/B Original** switching | ✅ Decided (2026-11-16) |

---

*End of document. Phases 0–2 complete and verified (2026-11-16); Phase 3 cleared to start.*