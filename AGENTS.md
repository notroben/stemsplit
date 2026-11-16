# AGENTS.md — StemSplit Engineering & Agent Guide

> **Authority:** `TECHNICAL_DESIGN.md` is the authoritative specification for what this project
> builds, why decisions were made, and how each phase is gated. Read it before writing code. Where
> implementation reality diverges from `TECHNICAL_DESIGN.md`, update the design document's
> *"As built"* notes in the same turn — never let the code and the spec drift apart silently.

---

## 1. Golden Rules (Non-Negotiable)

Every change across Rust, Python, and TypeScript must obey these six invariants:

1. **Zero-Copy Audio Transport:**
   - The Python sidecar **never** sends raw audio bytes or base64 audio payloads over JSON.
   - Python writes separated stems directly to `~/.stemsplit/jobs/<job_id>/*.wav` and returns file
     paths in `manifest.json`. The frontend loads audio files via Tauri's `asset://` protocol
     (`convertFileSrc`).

2. **Sample-Accurate Web Audio Clock (No `<audio>` Tag Drift):**
   - **Never** use multiple HTML `<audio>` elements to play stems concurrently — they drift by
     $5\text{--}20\text{ ms}$ on seek and cause comb-filtering across shared frequencies.
   - All stems in a job must be decoded into `AudioBuffer` instances under **one** shared
     `AudioContext`. Playback starts all `AudioBufferSourceNode` instances at the exact same
     hardware timestamp (`ctx.currentTime + 0.02`) and buffer offset.
   - Mute, Solo, and Volume faders must use `GainNode.gain.setTargetAtTime(target, ctx.currentTime, 0.01)`
     ($10\text{ ms}$ time constant) so toggling Solo/Mute mid-playback never produces an audible
     click or pop.

3. **No Zombie Python Processes or Locked VRAM:**
   - Closing the Tauri window **must** kill the Python sidecar and all of its child worker
     processes within $1\text{ second}$.
   - On Windows, standard `Child::kill()` only terminates the top-level wrapper and orphans child
     workers. Always terminate the full process tree (`taskkill /F /T /PID <pid>` on Windows;
     process-group kill on Unix) **and** pass `--parent-pid <tauri_pid>` to Python so the sidecar
     runs a background watchdog thread that self-terminates if the Tauri host disappears.

4. **Strict VRAM Hygiene:**
   - Keep at most **one** `Separator` model loaded in memory at any time.
   - Before switching presets (e.g., from `BS-RoFormer` to `htdemucs_ft`), explicitly delete the
     existing model instance, run `gc.collect()`, and call `torch.cuda.empty_cache()` so $4\text{--}6\text{ GB}$
     GPUs never hit `torch.cuda.OutOfMemoryError`.
   - Always enable `use_autocast=True` (FP16) when CUDA is available.

5. **State Changes May Alter Appearance, Never Geometry:**
   - Toggling a button (`Play` / `Pause`, `S`, `M`), switching a status badge, or updating a
     percentage readout must **never** cause neighbouring columns, sliders, or track rows to shift
     by even $1\text{ px}$.
   - Use `font-variant-numeric: tabular-nums` on all timers, percentages, and dB/volume readouts.
   - Reserve fixed widths or stack both label states in a single CSS grid cell (`visibility: hidden`
     on the inactive label) so controls never resize on click.

6. **Comment Policy:**
   - Comments in code explain **what the code does and why it is shaped that way** — concise, and
     strictly about the code as it stands today.
   - **Do not put change history in code comments:** no *"this used to be X"*, no record of what was
     tried and rejected, and no test logs. Historical rationale belongs in `TECHNICAL_DESIGN.md`.

---

## 2. Architecture & Layer Boundaries

```
stemsplit/
├── TECHNICAL_DESIGN.md         <- Architecture, decisions, phase gates, and "As built" log
├── AGENTS.md                   <- This file
├── src/                        <- React + TypeScript UI & Web Audio mixer
├── src-tauri/                  <- Rust OS shell, sidecar supervisor, native dialogs
└── sidecar/                    <- Python FastAPI + python-audio-separator + FFmpeg
```

| Layer | Owns | Must NEVER Do |
|---|---|---|
| **Python (`sidecar/`)** | `python-audio-separator`, PyTorch/CUDA management, `ffprobe`/`ffmpeg` subprocesses, `~/.stemsplit/` workspace & `manifest.json` files | Open GUI windows, hold more than one model in VRAM, or return un-normalized filenames |
| **Rust (`src-tauri/`)** | Finding a free localhost port, spawning `sidecar/server.py` (with `CREATE_NO_WINDOW` on Windows), health-checking `/health`, killing the process tree on exit, native file/folder dialogs | Run ML inference or parse audio buffers |
| **Frontend (`src/`)** | Drag-and-drop ingest, SSE progress display, Web Audio API synchronized playback, `<canvas>` waveform peaks, Solo/Mute/Volume state | Spawn OS processes directly or guess localhost ports (always ask Rust via `invoke('get_sidecar_url')`) |

---

## 3. Layer-Specific Implementation Rules

### 3.1 Python Sidecar (`sidecar/`)

- **Virtual Environment (Python 3.11):** Create `sidecar/.venv` explicitly with Python 3.11 64-bit
  (`py -3.11 -m venv sidecar/.venv`) rather than Python 3.13 so PyTorch CUDA, `onnxruntime-gpu`,
  and `audio-separator[gpu]` prebuilt wheels install cleanly on Windows. Never install packages
  into the system Python.
- **Canonical Presets Only:** Map the three UI preset IDs (`roformer_2stem`, `htdemucs_4stem`,
  `htdemucs_6stem`) to their exact model filenames in one dictionary (`PRESETS` in `worker.py`):
  - `roformer_2stem` $\rightarrow$ `model_bs_roformer_ep_317_sdr_12.9755.ckpt`
  - `htdemucs_4stem` $\rightarrow$ `htdemucs_ft.yaml`
  - `htdemucs_6stem` $\rightarrow$ `htdemucs_6s.yaml`
- **4 GB VRAM Safe Defaults (`worker.py`):** Configure `Separator` with `use_autocast=True` (FP16)
  whenever CUDA is available, plus conservative 4 GB VRAM defaults:
  - `mdxc_params={"segment_size": 256, "override_model_segment_size": False, "batch_size": 1, "overlap": 4}`
  - `demucs_params={"segments_enabled": True, "shifts": 1, "overlap": 0.25}`
- **Deterministic Stem Filenames via `original.wav`:** Always normalize the user's input file to
  `~/.stemsplit/jobs/<job_id>/original.wav` (`44100 Hz`, stereo) via `ffmpeg` first, and pass
  **only `original.wav`** (never the raw user filename) into `separator.separate()`. This guarantees
  predictable `original_(<Stem>)_*.wav` outputs immune to parentheses or special characters in song
  titles. Immediately after `separator.separate()` completes, rename the outputs into canonical stem
  names inside `~/.stemsplit/jobs/<job_id>/` (`Vocals.wav`, `Instrumental.wav`, `Drums.wav`,
  `Bass.wav`, `Guitar.wav`, `Piano.wav`, `Other.wav`) before writing `manifest.json`.
- **Progress Streaming & Cooperative Cancellation (`TqdmToSSE`):** `audio-separator` writes progress
  to `tqdm`. Intercept `tqdm` writes in `TqdmToSSE` to parse percentage updates and push them into
  an `asyncio.Queue` consumed by `GET /jobs/{id}/events` as Server-Sent Events
  (`data: {"stage": ..., "percent": ...}\n\n`). On every `tqdm` update tick, `TqdmToSSE` must also
  check the job's `threading.Event` (`cancel_event`) and raise `JobCancelledError` when set —
  unwinding `separator.separate()` cleanly at the next chunk boundary (~$0.5\text{--}1.5\text{ s}$),
  running `gc.collect()` + `torch.cuda.empty_cache()`, and deleting partial files without killing
  the FastAPI process.
- **FFmpeg Subprocesses & Custom Mixdown Filtergraph:** Always invoke `ffmpeg` and `ffprobe` with
  `-hide_banner -loglevel error` and explicit argument lists (`subprocess.run([...], check=True)`),
  never `shell=True` (prevents path-quoting bugs on song titles containing spaces, quotes, or
  brackets). For custom mixdowns in `POST /export`, build an `amix` filtergraph with
  `normalize=0` and a safety limiter:
  `amix=inputs=N:duration=longest:dropout_transition=0:weights='...':normalize=0,alimiter=limit=0.99:level=disabled`
  so FFmpeg preserves exact mixer gain ratios without dividing output level by $1/N$ and prevents
  digital clipping when stems are boosted above $100\%$.

### 3.2 Rust Core (`src-tauri/`)

- **Dynamic Port Allocation:** Before spawning Python, bind a `std::net::TcpListener` to
  `127.0.0.1:0`, read the OS-assigned port, drop the listener, and pass `--port <port>` and
  `--parent-pid <std::process::id()>` to the Python sidecar. Store the port in Tauri managed state.
- **Silent Spawn on Windows:** Always apply `.creation_flags(0x08000000)` (`CREATE_NO_WINDOW`) on
  `#[cfg(target_os = "windows")]` when spawning `python.exe` or `ffmpeg.exe` so terminal windows
  never flash over the desktop UI.
- **Asset Protocol Scope & Tauri v2 Capabilities:** Enable the `protocol-asset` Cargo feature on
  `tauri`, configure `assetProtocol` in `tauri.conf.json` with scope permitting
  `$HOME/.stemsplit/**`, and declare Tauri v2 permissions (dialog, opener, and asset protocol
  capabilities) in `src-tauri/capabilities/default.json` so the Web Audio engine can
  `fetch(convertFileSrc(path))` without CORS or permission errors.

### 3.3 Frontend & Web Audio Engine (`src/`)

- **Audio Buffer Lifecycle:** When loading a job into `MixerView`, decode all stems **and**
  `manifest.original_path` (`original.wav`) in parallel via
  `Promise.all(tracks.map(t => fetch(convertFileSrc(t.path)).then(r => r.arrayBuffer()).then(b => ctx.decodeAudioData(b))))`,
  starting every stem `AudioBufferSourceNode` and the `original.wav` `AudioBufferSourceNode` at the
  exact same `ctx.currentTime + 0.02` offset.
- **Memory Cleanup on Job Switch:** When the user navigates back to the dropzone or loads a
  different song from history, stop all active `AudioBufferSourceNode`s, disconnect nodes, and
  drop references to the previous `AudioBuffer`s so $500\text{ MB}$ of decoded PCM data does not
  accumulate in RAM across songs.
- **Effective Gain Formula (including `A/B Original`):**
  - When `abOriginal` is active: `originalGainNode` targets `1.0` and all stem `GainNode`s target
    `0` via `gain.setTargetAtTime(target, ctx.currentTime, 0.01)`.
  - Otherwise: `originalGainNode` targets `0`, and each stem is audible if and only if
    `!stem.muted && (!anySoloed || stem.soloed)`, targeting `stem.volume` (range $0.0\text{--}1.5$)
    when active and `0` when muted/un-soloed.
- **Waveform Peaks:** Compute min/max peak pairs once per `AudioBuffer` upon decode ($1{,}000\text{--}1{,}500$
  buckets) and cache the `Float32Array` on the stem state. Redraw the `<canvas>` on window resize or
  playhead tick using `requestAnimationFrame` — never recompute PCM peaks on every animation frame.

---

## 4. UI & Styling Conventions

- **Fixed-Viewport Desktop App:** The app is a native studio utility, not a marketing webpage.
  `html, body, #root` must be `height: 100vh; overflow: hidden; user-select: none;`. Only the stem
  track list and the history sidebar scroll internally (`scrollbar-width: thin`, transparent track).
- **Scoped Styling:** Use the CSS variables defined in `TECHNICAL_DESIGN.md` §7.1 (`--bg-app`,
  `--bg-panel`, `--stem-vocals`, etc.). Never write bare global element rules (`button`, `table`,
  `input`) without scoping or explicit reset inheritance (`button { color: inherit; font: inherit; }`).
- **Error Transparency:** Never fail silently or fall through to an unrelated action. If a model
  download fails, FFmpeg is missing, or CUDA runs out of memory, surface the exact actionable error
  in the UI with a retry/recovery path.

---

## 5. Phased Execution & Verification Protocol

**Do not build all phases in one giant unverified commit.** Build phase by phase according to
`TECHNICAL_DESIGN.md` §9, and run the verification gate for the current phase before starting the
next.

### Phase 0 Gate — Environment & Sidecar Lifecycle
0. Verify/install host prerequisites on Windows (`winget install Rustlang.Rustup` for `cargo` and
   `winget install Gyan.FFmpeg` for `ffmpeg`/`ffprobe`, refreshing the shell `PATH`).
1. Create `sidecar/.venv` with Python 3.11 (`py -3.11 -m venv sidecar/.venv`), install PyTorch CUDA
   wheels, `fastapi`, `uvicorn`, and `audio-separator[gpu]`.
2. Run `sidecar/.venv/Scripts/audio-separator --env_info` (or `bin/audio-separator` on Unix) and
   verify that **FFmpeg** is found and **PyTorch CUDA** (or MPS) is detected.
3. Start `sidecar/server.py` and verify `GET http://127.0.0.1:<port>/health` returns `status: "ok"`
   with the expected hardware device.
4. Launch the Tauri window (`npm run tauri dev`), confirm the UI displays the hardware badge from
   `/health`, then close the window and verify via `tasklist` / `ps` that no `python` process
   remains running.

### Phase 1 Gate — Ingest, Separation & Live SSE Progress
1. Trigger `POST /separate` with a short test audio file ($10\text{--}30\text{ s}$) on the
   `roformer_2stem` preset.
2. Verify `GET /jobs/{id}/events` streams `loading_model` $\rightarrow$ `separating` ($0\text{--}100\%$)
   $\rightarrow$ `completed`.
3. Verify `~/.stemsplit/jobs/<id>/manifest.json`, `original.wav`, `Vocals.wav`, and
   `Instrumental.wav` exist on disk and are non-empty valid WAV files.

### Phase 2 Gate — Synchronized DAW Mixer & Export
1. Load a completed 4-stem job into `MixerView`.
2. Verify Play, Pause, Seek, Solo (`S`), Mute (`M`), and `A/B Original` work with zero phase
   flanging and zero layout shift when buttons toggle.
3. Trigger `POST /export` with `Drums` muted in `.mp3` ($320\text{ kbps}$) format and verify with
   `ffprobe` that the exported file exists, matches the source duration, and plays cleanly.

### Phase 3 Gate — History & Cache Management
1. Restart the app, open the History drawer, click a previous job, and verify it loads into the
   mixer in $< 1\text{ s}$ without invoking `Separator`.
2. Verify deleting a job removes its folder from `~/.stemsplit/jobs/` and updates the cache size
   readout immediately.

---

## 6. Maintaining `TECHNICAL_DESIGN.md`

Whenever you complete a phase, resolve an open decision (`D-a` through `D-d` in §11), or discover a
platform/GPU quirk during testing:
1. Update `## 0. Status` in `TECHNICAL_DESIGN.md` to reflect what is built and verified.
2. Add an **"As built (YYYY-MM-DD)"** note under the relevant feature section (§6.1–§6.6)
   documenting any non-obvious edge cases or implementation details.
3. Mark resolved items in `## 11. Remaining Open Decisions` with ✅ and the date decided.