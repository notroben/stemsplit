"""LAN IP discovery, QR SVG generation, auxiliary 0.0.0.0 server, and mobile HTML UI."""

from __future__ import annotations

import io
import socket
import threading
import time
from typing import Any

import qrcode
import qrcode.image.svg
import uvicorn

DEFAULT_LAN_PORT = 7860


def detect_lan_ip() -> str:
    """Detect the host machine's active LAN IPv4 address without transmitting packets."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            ip = sock.getsockname()[0]
            if ip and not ip.startswith("127."):
                return ip
    except OSError:
        pass

    try:
        _, _, addrs = socket.gethostbyname_ex(socket.gethostname())
        for addr in addrs:
            if addr and not addr.startswith("127.") and ":" not in addr:
                return addr
    except OSError:
        pass

    return "127.0.0.1"


def generate_qr_svg(url: str) -> str:
    """Render a clean inline SVG QR code for the given URL."""
    qr = qrcode.QRCode(border=2, box_size=8)
    qr.add_data(url)
    qr.make(fit=True)
    img = qr.make_image(image_factory=qrcode.image.svg.SvgPathImage)
    buffer = io.BytesIO()
    img.save(buffer)
    return buffer.getvalue().decode("utf-8")


def _find_lan_port(preferred: int = DEFAULT_LAN_PORT) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind(("0.0.0.0", preferred))
            return preferred
        except OSError:
            probe.bind(("0.0.0.0", 0))
            return int(probe.getsockname()[1])


class LanServerManager:
    """Manages an optional auxiliary 0.0.0.0 uvicorn listener for LAN mobile access."""

    def __init__(self, preferred_port: int = DEFAULT_LAN_PORT) -> None:
        self._preferred_port = preferred_port
        self._lock = threading.Lock()
        self._server: uvicorn.Server | None = None
        self._thread: threading.Thread | None = None
        self._port: int = preferred_port
        self._enabled: bool = False
        self._lan_ip: str = "127.0.0.1"
        self._url: str | None = None
        self._qr_svg: str | None = None

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "enabled": self._enabled,
                "port": self._port,
                "lan_ip": self._lan_ip,
                "url": self._url,
                "qr_svg": self._qr_svg,
            }

    def start(self, fastapi_app: Any) -> dict[str, Any]:
        with self._lock:
            if self._enabled and self._thread is not None and self._thread.is_alive():
                return {
                    "enabled": True,
                    "port": self._port,
                    "lan_ip": self._lan_ip,
                    "url": self._url,
                    "qr_svg": self._qr_svg,
                }

            port = _find_lan_port(self._preferred_port)
            config = uvicorn.Config(
                fastapi_app,
                host="0.0.0.0",
                port=port,
                log_level="warning",
            )
            server = uvicorn.Server(config)
            # Uvicorn cannot install OS signal handlers from a non-main thread.
            server.install_signal_handlers = lambda: None  # type: ignore[method-assign]

            thread = threading.Thread(
                target=server.run,
                name="lan-companion-server",
                daemon=True,
            )
            thread.start()

            deadline = time.monotonic() + 3.0
            while not server.started and thread.is_alive() and time.monotonic() < deadline:
                time.sleep(0.05)

            if not server.started:
                server.should_exit = True
                thread.join(timeout=1.0)
                raise RuntimeError(f"Failed to start LAN companion listener on 0.0.0.0:{port}")

            lan_ip = detect_lan_ip()
            url = f"http://{lan_ip}:{port}"
            self._server = server
            self._thread = thread
            self._port = port
            self._enabled = True
            self._lan_ip = lan_ip
            self._url = url
            self._qr_svg = generate_qr_svg(url)

            return {
                "enabled": True,
                "port": self._port,
                "lan_ip": self._lan_ip,
                "url": self._url,
                "qr_svg": self._qr_svg,
            }

    def stop(self) -> dict[str, Any]:
        with self._lock:
            server = self._server
            thread = self._thread
            self._server = None
            self._thread = None
            self._enabled = False
            self._url = None
            self._qr_svg = None

        if server is not None:
            server.should_exit = True
        if thread is not None and thread.is_alive():
            thread.join(timeout=3.0)

        return self.status()


MOBILE_HTML = """<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0" />
  <title>StemSplit Mobile Companion</title>
  <style>
    :root {
      --bg: #0f1115;
      --panel: #171a21;
      --elevated: #212631;
      --border: rgba(255, 255, 255, 0.1);
      --text: #f3f4f6;
      --muted: #9ca3af;
      --teal: #2dd4bf;
      --rose: #f43f5e;
      --ok: #10b981;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 16px;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 15px;
      line-height: 1.45;
    }
    .wrap {
      max-width: 520px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 16px;
      border-radius: 14px;
      background: var(--panel);
      border: 1px solid var(--border);
    }
    .brand { font-size: 17px; font-weight: 700; }
    .sub { font-size: 12px; color: var(--muted); }
    .pill {
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      background: rgba(16, 185, 129, 0.15);
      color: #a7f3d0;
      border: 1px solid rgba(16, 185, 129, 0.35);
    }
    .card {
      padding: 16px;
      border-radius: 14px;
      background: var(--panel);
      border: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .label {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
    }
    .file-box {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 16px;
      border-radius: 12px;
      border: 1.5px dashed rgba(255, 255, 255, 0.22);
      background: var(--bg);
      text-align: center;
    }
    input[type="file"] {
      width: 100%;
      color: var(--muted);
      font-size: 13px;
    }
    .presets { display: flex; flex-direction: column; gap: 8px; }
    .preset-opt {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 11px 12px;
      border-radius: 10px;
      background: var(--elevated);
      border: 1px solid var(--border);
      cursor: pointer;
    }
    .preset-opt input { accent-color: var(--teal); }
    .btn {
      width: 100%;
      height: 44px;
      border: 0;
      border-radius: 10px;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }
    .btn-primary { background: var(--teal); color: #091015; }
    .btn-primary:disabled { opacity: 0.45; cursor: not-allowed; }
    .btn-danger {
      background: rgba(244, 63, 94, 0.16);
      color: #fecdd3;
      border: 1px solid rgba(244, 63, 94, 0.4);
    }
    .progress-row {
      display: flex;
      justify-content: space-between;
      font-size: 13px;
      font-variant-numeric: tabular-nums;
    }
    .bar-track {
      width: 100%;
      height: 10px;
      border-radius: 999px;
      background: var(--elevated);
      overflow: hidden;
    }
    .bar-fill {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, #2dd4bf, #3b82f6);
      transition: width 0.2s ease;
    }
    .stem-row {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 12px;
      border-radius: 10px;
      background: var(--elevated);
      border: 1px solid var(--border);
    }
    .stem-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .stem-check {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
    }
    .stem-check input { width: 18px; height: 18px; accent-color: var(--teal); }
    .stem-dl {
      padding: 5px 10px;
      border-radius: 7px;
      background: var(--panel);
      border: 1px solid var(--border);
      color: var(--text);
      text-decoration: none;
      font-size: 12px;
      font-weight: 600;
    }
    .slider-row {
      display: flex;
      align-items: center;
      gap: 10px;
      font-variant-numeric: tabular-nums;
      font-size: 12px;
      color: var(--muted);
    }
    .slider-row input[type="range"] { flex: 1; accent-color: var(--teal); }
    .alert {
      padding: 10px 12px;
      border-radius: 10px;
      background: rgba(244, 63, 94, 0.14);
      border: 1px solid rgba(244, 63, 94, 0.4);
      color: #fecdd3;
      font-size: 13px;
    }
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <div>
        <div class="brand">StemSplit Mobile</div>
        <div class="sub">Powered by your PC GPU</div>
      </div>
      <span class="pill" id="hw-pill">LAN Ready</span>
    </div>

    <div id="error-box" class="alert hidden"></div>

    <div id="upload-card" class="card">
      <div class="label">1. Choose Song or Video</div>
      <div class="file-box">
        <input id="file-input" type="file" accept="audio/*,video/*,.mp3,.wav,.flac,.m4a,.aac,.ogg,.mp4,.mkv,.mov" />
      </div>

      <div class="label">2. Separation Preset</div>
      <div class="presets">
        <label class="preset-opt">
          <input type="radio" name="preset" value="roformer_2stem" checked />
          <span>2 Stems · Vocals &amp; Instrumental</span>
        </label>
        <label class="preset-opt">
          <input type="radio" name="preset" value="htdemucs_4stem" />
          <span>4 Stems · Vocals, Drums, Bass, Other</span>
        </label>
        <label class="preset-opt">
          <input type="radio" name="preset" value="htdemucs_6stem" />
          <span>6 Stems · + Guitar &amp; Piano</span>
        </label>
      </div>

      <button id="split-btn" class="btn btn-primary" disabled>Split on PC GPU</button>
    </div>

    <div id="progress-card" class="card hidden">
      <div class="label">Processing on PC</div>
      <div class="progress-row">
        <span id="stage-text">Uploading…</span>
        <span id="pct-text">0%</span>
      </div>
      <div class="bar-track"><div id="bar-fill" class="bar-fill"></div></div>
      <button id="cancel-btn" class="btn btn-danger">Cancel</button>
    </div>

    <div id="result-card" class="card hidden">
      <div class="label">Stems Ready · Toggle &amp; Download</div>
      <div id="song-title" style="font-weight:700;word-break:break-word;"></div>
      <div id="stems-list" style="display:flex;flex-direction:column;gap:8px;"></div>
      <button id="mix-btn" class="btn btn-primary">Download Mix (.mp3)</button>
      <button id="reset-btn" class="btn" style="background:var(--elevated);color:var(--text);">Split Another Track</button>
    </div>
  </div>

  <script>
    const fileInput = document.getElementById("file-input");
    const splitBtn = document.getElementById("split-btn");
    const uploadCard = document.getElementById("upload-card");
    const progressCard = document.getElementById("progress-card");
    const resultCard = document.getElementById("result-card");
    const stageText = document.getElementById("stage-text");
    const pctText = document.getElementById("pct-text");
    const barFill = document.getElementById("bar-fill");
    const cancelBtn = document.getElementById("cancel-btn");
    const stemsList = document.getElementById("stems-list");
    const songTitle = document.getElementById("song-title");
    const mixBtn = document.getElementById("mix-btn");
    const resetBtn = document.getElementById("reset-btn");
    const errorBox = document.getElementById("error-box");
    const hwPill = document.getElementById("hw-pill");

    let activeJobId = null;
    let activeManifest = null;
    let stemState = {};
    let activeSource = null;

    fetch("/health").then(r => r.json()).then(h => {
      hwPill.textContent = h.device === "cuda" ? "GPU: CUDA" : h.device.toUpperCase();
    }).catch(() => {});

    function showError(msg) {
      errorBox.textContent = msg;
      errorBox.classList.remove("hidden");
    }

    function clearError() {
      errorBox.classList.add("hidden");
      errorBox.textContent = "";
    }

    fileInput.addEventListener("change", () => {
      clearError();
      splitBtn.disabled = !fileInput.files || fileInput.files.length === 0;
    });

    splitBtn.addEventListener("click", () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      clearError();
      const preset = document.querySelector('input[name="preset"]:checked').value;

      uploadCard.classList.add("hidden");
      resultCard.classList.add("hidden");
      progressCard.classList.remove("hidden");
      stageText.textContent = "Uploading audio to PC…";
      pctText.textContent = "0%";
      barFill.style.width = "0%";
      cancelBtn.disabled = true;

      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/mobile/upload?preset_id=${encodeURIComponent(preset)}&filename=${encodeURIComponent(file.name)}`);
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) {
          const pct = Math.round((ev.loaded / ev.total) * 100);
          pctText.textContent = `${pct}%`;
          barFill.style.width = `${pct}%`;
        }
      };
      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300) {
          let detail = `Upload failed (HTTP ${xhr.status})`;
          try { detail = JSON.parse(xhr.responseText).detail || detail; } catch {}
          progressCard.classList.add("hidden");
          uploadCard.classList.remove("hidden");
          showError(detail);
          return;
        }
        const data = JSON.parse(xhr.responseText);
        activeJobId = data.job_id;
        cancelBtn.disabled = false;
        listenProgress(activeJobId);
      };
      xhr.onerror = () => {
        progressCard.classList.add("hidden");
        uploadCard.classList.remove("hidden");
        showError("Network error while uploading file.");
      };
      xhr.send(file);
    });

    function listenProgress(jobId) {
      if (activeSource) activeSource.close();
      activeSource = new EventSource(`/jobs/${encodeURIComponent(jobId)}/events`);
      activeSource.onmessage = async (msg) => {
        const ev = JSON.parse(msg.data);
        stageText.textContent = ev.message || ev.stage;
        const pct = Math.max(0, Math.min(100, ev.percent || 0));
        pctText.textContent = `${pct}%`;
        barFill.style.width = `${pct}%`;

        if (ev.stage === "completed") {
          activeSource.close();
          activeSource = null;
          const res = await fetch(`/jobs/${encodeURIComponent(jobId)}`);
          activeManifest = await res.json();
          renderResult(activeManifest);
        } else if (ev.stage === "failed" || ev.stage === "cancelled") {
          activeSource.close();
          activeSource = null;
          progressCard.classList.add("hidden");
          uploadCard.classList.remove("hidden");
          showError(ev.message || "Separation did not complete.");
        }
      };
      activeSource.onerror = () => {
        if (activeSource) activeSource.close();
        activeSource = null;
        progressCard.classList.add("hidden");
        uploadCard.classList.remove("hidden");
        showError("Lost progress connection to PC.");
      };
    }

    cancelBtn.addEventListener("click", async () => {
      if (!activeJobId) return;
      cancelBtn.disabled = true;
      await fetch(`/jobs/${encodeURIComponent(activeJobId)}/cancel`, { method: "POST" });
    });

    function renderResult(manifest) {
      progressCard.classList.add("hidden");
      resultCard.classList.remove("hidden");
      songTitle.textContent = manifest.source_name;
      stemsList.innerHTML = "";
      stemState = {};

      manifest.stems.forEach((stem) => {
        stemState[stem.id] = { id: stem.id, volume: 1.0, muted: false, soloed: false };
        const row = document.createElement("div");
        row.className = "stem-row";

        const top = document.createElement("div");
        top.className = "stem-top";

        const label = document.createElement("label");
        label.className = "stem-check";
        const chk = document.createElement("input");
        chk.type = "checkbox";
        chk.checked = true;
        chk.addEventListener("change", () => {
          stemState[stem.id].muted = !chk.checked;
        });
        const dot = document.createElement("span");
        dot.style.cssText = `width:10px;height:10px;border-radius:50%;background:${stem.color};display:inline-block;`;
        const name = document.createElement("span");
        name.textContent = stem.label;
        label.append(chk, dot, name);

        const dl = document.createElement("a");
        dl.className = "stem-dl";
        dl.href = `/mobile/jobs/${encodeURIComponent(manifest.id)}/stem/${encodeURIComponent(stem.id)}`;
        dl.textContent = "Save .mp3";

        top.append(label, dl);

        const sliderRow = document.createElement("div");
        sliderRow.className = "slider-row";
        const range = document.createElement("input");
        range.type = "range";
        range.min = "0";
        range.max = "150";
        range.value = "100";
        const pctSpan = document.createElement("span");
        pctSpan.style.width = "40px";
        pctSpan.style.textAlign = "right";
        pctSpan.textContent = "100%";
        range.addEventListener("input", () => {
          pctSpan.textContent = `${range.value}%`;
          stemState[stem.id].volume = Number(range.value) / 100;
        });
        sliderRow.append(document.createTextNode("Vol"), range, pctSpan);

        row.append(top, sliderRow);
        stemsList.append(row);
      });
    }

    mixBtn.addEventListener("click", async () => {
      if (!activeManifest) return;
      clearError();
      mixBtn.disabled = true;
      mixBtn.textContent = "Encoding MP3…";
      try {
        const res = await fetch(`/mobile/jobs/${encodeURIComponent(activeManifest.id)}/mix`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stems: Object.values(stemState) }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.detail || `Mix export failed (HTTP ${res.status})`);
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const base = activeManifest.source_name.replace(/\\.[^/.]+$/, "");
        a.href = url;
        a.download = `${base} (StemSplit Mix).mp3`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      } catch (err) {
        showError(err.message || "Failed to download mix.");
      } finally {
        mixBtn.disabled = false;
        mixBtn.textContent = "Download Mix (.mp3)";
      }
    });

    resetBtn.addEventListener("click", () => {
      clearError();
      resultCard.classList.add("hidden");
      uploadCard.classList.remove("hidden");
      fileInput.value = "";
      splitBtn.disabled = true;
    });
  </script>
</body>
</html>
"""
