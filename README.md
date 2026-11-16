# StemSplit

StemSplit is a local desktop AI stem separator and multi-track audio mixer for Windows. Split any audio or video file into isolated tracks (`Vocals`, `Instrumental`, `Drums`, `Bass`, `Guitar`, `Piano`, `Other`) directly on your own GPU with zero cloud uploads, no file limits, and sample-accurate playback.

---

## Features

- **Local AI Separation:** Runs open-source `BS-RoFormer` and `HTDemucs` models locally on your NVIDIA GPU (CUDA, tuned to run safely on 4 GB+ VRAM cards) or falls back automatically to CPU.
- **Broad Format Support:** Drag and drop or browse `MP3`, `WAV`, `FLAC`, `M4A`, `AAC`, `OGG`, `MP4`, `MKV`, and `MOV` files.
- **Synchronized Multi-Track Mixer:** Play all separated stems locked in sync with interactive waveforms, per-stem Solo (`S`), Mute (`M`), volume sliders (up to 150%), Master volume, Loop toggle, and instant **A/B Original** comparison.
- **Flexible Export:** Bounce a custom mix matching your Solo/Mute/slider settings, save individual stems, or batch-export all stems to a folder or `.zip` archive in `MP3` (320 kbps CBR), `WAV` (16-bit PCM), or `FLAC` (lossless).
- **Instant Separation History:** Reopen past songs immediately from the History drawer without re-running separation, or clear individual songs and cache folders to free disk space.
- **Mobile Companion (Wi-Fi):** Optionally start a local Wi-Fi page with a QR code so you can upload tracks from your phone, run separation on your PC GPU, and download stems or custom MP3 mixes back to your phone.

---

## Requirements

Before running `StemSplit.exe`, make sure your Windows PC has:

- **OS:** Windows 10 or Windows 11 (64-bit) with **Microsoft Edge WebView2 Runtime** (pre-installed on Windows 10/11).
- **FFmpeg:** Required to read compressed audio/video files and export mixes/stems.
  Install via winget in PowerShell or Command Prompt, then reopen your terminal/app:
  ```powershell
  winget install Gyan.FFmpeg
  ```
- **GPU (Recommended):** NVIDIA GPU with up-to-date drivers (4 GB+ VRAM supported). If no compatible GPU is detected, StemSplit still works in CPU mode at slower speeds.
- **Sidecar Runtime (`sidecar/`):** `StemSplit.exe` expects the `sidecar/` folder (containing `server.py` and the Python 3.11 `.venv` environment) in the same directory as `StemSplit.exe`.

---

## Getting Started

### 1. First-Time Setup (If `sidecar/.venv` is not already included)

If your download only includes the source/release files without a prebuilt `sidecar/.venv` folder, install **Python 3.11 (64-bit)** and set up the sidecar environment once from the folder containing `StemSplit.exe`:

```powershell
py -3.11 -m venv sidecar/.venv
.\sidecar\.venv\Scripts\python.exe -m pip install --upgrade pip
.\sidecar\.venv\Scripts\python.exe -m pip install -r sidecar/requirements.txt
```

### 2. Launch StemSplit

Double-click `StemSplit.exe`.

Wait a few seconds while the local engine initializes. The top-right status badge will turn green once ready (for example, `GPU: NVIDIA GeForce ... (CUDA)` or `CPU Mode (Slower)`). If FFmpeg is missing from your system `PATH`, an alert banner will appear with a **Check Again** button after installing FFmpeg.

---

## How to Use

### 1. Split a Track
1. Drag and drop an audio or video file onto the workspace (or click **Browse File**).
2. Choose a separation preset:
   - **Vocals & Instrumental (Best Quality)** (`2 Stems`): Ideal for acapellas, karaoke instrumentals, and clean vocal isolation using BS-RoFormer.
   - **4-Stem Band Split** (`4 Stems`): Separates `Vocals`, `Drums`, `Bass`, and `Other` using HTDemucs Fine-Tuned.
   - **6-Stem Full Split (+ Guitar & Piano)** (`6 Stems`): Separates `Vocals`, `Drums`, `Bass`, `Guitar`, `Piano`, and `Other`.
3. Click **Split Stems**.
   - On the very first run of a preset, StemSplit automatically downloads its AI model weights (~640 MB for BS-RoFormer, ~80-170 MB for HTDemucs) into your local cache. Subsequent runs load directly from disk.
   - Click **Cancel** at any time during separation to abort cleanly and discard partial files.

### 2. Mix & Preview
Once separation completes, StemSplit opens the mixer view:
- Click **Play** (or press `Space`) to start synchronized playback.
- Click or drag anywhere along a waveform to seek all stems together.
- Use **S** (Solo) and **M** (Mute) on any track, or adjust per-track and **Master** sliders (`0%` to `150%`).
- Click **A/B Original** to switch instantaneously between your stem mix and the original unsplit track.
- Double-click any volume slider to reset it to `100%`.

#### Keyboard Shortcuts
| Shortcut | Action |
|---|---|
| `Space` | Play / Pause |
| `1` - `6` | Toggle Solo on stems 1 through 6 |
| `Ctrl + E` | Open Export modal |

### 3. Export Audio
Click **Export** (or press `Ctrl + E`):
- **Output Format:** Choose `MP3` (`320 kbps CBR`), `WAV` (`16-bit PCM`), or `FLAC` (`Lossless`).
- **Custom Mix ("What You Hear"):** Bounces a single audio file using your active Solo, Mute, and slider levels.
- **Individual Stems & Batch:** Save a single stem, export all stems individually into a chosen folder (**Export All to Folder...**), or package all stems into one archive (**Export All as ZIP...**).
- After exporting finishes, click **Show Folder** to open the destination directory in Windows Explorer.

### 4. History & Cache
- Click **History** in the top bar to open or collapse the saved separations list.
- Click any past song to reload its stems into the mixer immediately without re-running separation.
- Delete individual entries with the trash icon, or click **Clear All Cache** (followed by **Confirm Clear All?**) to remove all cached separations.

### 5. Mobile Companion (Wi-Fi)
1. Click **Mobile (Wi-Fi)** in the header and enable the listener if needed.
2. Scan the QR code from your phone (must be connected to the same Wi-Fi network as your PC).
   - If Windows Firewall prompts when enabling this for the first time, allow access on your **Private** network.
3. Upload a song from your phone, let your PC GPU split it, adjust levels, and download individual stems or an MP3 mix directly to your phone.
4. Click **Turn Off Mobile Companion** when finished to stop the LAN listener.

---

## Data & Cache Locations

All workspace data is stored locally under your user profile directory (`%USERPROFILE%\.stemsplit\`):
- `%USERPROFILE%\.stemsplit\models\` — Downloaded AI model weights.
- `%USERPROFILE%\.stemsplit\jobs\` — Normalized audio, separated `.wav` stems, and job manifests shown in History.

---

## Troubleshooting

- **"FFmpeg is missing from PATH" banner:** Install FFmpeg (`winget install Gyan.FFmpeg`), close and reopen `StemSplit.exe`, or click **Check Again**.
- **"Sidecar Offline" or startup failure:** Make sure `StemSplit.exe` has not been moved away from the `sidecar/` folder and that `sidecar/.venv/Scripts/python.exe` exists.
- **Tracks longer than 15 minutes:** Long tracks trigger a confirmation prompt because both GPU separation and decoding uncompressed PCM stems for playback use noticeably more RAM and disk space.
- **Phone cannot reach the Mobile Companion QR URL:** Verify both devices are on the same Wi-Fi network (AP isolation disabled) and allow `python.exe` through Windows Defender Firewall for Private networks.

---

## Building from Source (Developers)

Requires **Node.js 20+**, **Rust (`cargo`)**, **Python 3.11 (64-bit)**, and **FFmpeg**:

```powershell
npm install
py -3.11 -m venv sidecar/.venv
.\sidecar\.venv\Scripts\python.exe -m pip install -r sidecar/requirements.txt

# Run in development mode
npm run tauri dev

# Build release executable and installers
npm run tauri build
```
