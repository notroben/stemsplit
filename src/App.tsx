import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, AudioWaveform, RefreshCw, UploadCloud } from "lucide-react";
import {
  getHealth,
  getModels,
  getSidecarUrl,
  type HealthResponse,
  type ModelPreset,
} from "./lib/sidecar";

type ConnectionState = "connecting" | "online" | "offline";

const MAX_BOOT_ATTEMPTS = 15;
const BOOT_RETRY_MS = 400;

export default function App() {
  const [sidecarUrl, setSidecarUrl] = useState<string>("");
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [models, setModels] = useState<ModelPreset[]>([]);
  const [selectedPreset, setSelectedPreset] = useState<string>("roformer_2stem");
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  const probeSidecar = useCallback(async (withBootRetry: boolean) => {
    setConnection("connecting");
    setErrorDetail(null);

    const url = await getSidecarUrl();
    setSidecarUrl(url);

    const attempts = withBootRetry ? MAX_BOOT_ATTEMPTS : 1;
    for (let i = 0; i < attempts; i += 1) {
      try {
        const [healthData, modelList] = await Promise.all([
          getHealth(url),
          getModels(url),
        ]);
        setHealth(healthData);
        setModels(modelList);
        setConnection("online");
        return;
      } catch (err) {
        if (i === attempts - 1) {
          setConnection("offline");
          setErrorDetail(err instanceof Error ? err.message : "Sidecar unreachable");
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, BOOT_RETRY_MS));
      }
    }
  }, []);

  useEffect(() => {
    void probeSidecar(true);
  }, [probeSidecar]);

  const renderHardwareBadge = () => {
    if (connection === "connecting") {
      return (
        <div className="hardware-badge" title="Connecting to Python sidecar">
          <span className="hardware-dot warn" />
          <span>Connecting to Sidecar…</span>
        </div>
      );
    }

    if (connection === "offline" || !health) {
      return (
        <div className="hardware-badge" title={errorDetail ?? "Sidecar offline"}>
          <span className="hardware-dot error" />
          <span>Sidecar Offline</span>
        </div>
      );
    }

    if (health.device === "cuda") {
      const label = health.gpu_name
        ? `GPU: ${health.gpu_name} (CUDA)`
        : "GPU Mode (CUDA)";
      return (
        <div className="hardware-badge" title={label}>
          <span className="hardware-dot ok" />
          <span>{label}</span>
        </div>
      );
    }

    if (health.device === "mps") {
      return (
        <div className="hardware-badge" title="Apple Silicon MPS">
          <span className="hardware-dot ok" />
          <span>GPU: Apple Silicon (MPS)</span>
        </div>
      );
    }

    return (
      <div className="hardware-badge" title="Running on CPU">
        <span className="hardware-dot warn" />
        <span>CPU Mode (Slower)</span>
      </div>
    );
  };

  return (
    <div className="studio-shell">
      <header className="studio-header">
        <div className="studio-brand">
          <div className="studio-brand-mark">
            <AudioWaveform size={18} />
          </div>
          <div>
            <div className="studio-brand-title">StemSplit</div>
            <div className="studio-brand-subtitle">Local AI Stem Separator</div>
          </div>
        </div>

        <div className="header-controls">
          {renderHardwareBadge()}
          <button
            type="button"
            className="studio-btn"
            onClick={() => void probeSidecar(false)}
            disabled={connection === "connecting"}
          >
            <RefreshCw size={13} />
            <span>Check</span>
          </button>
        </div>
      </header>

      <main className="studio-main">
        {connection === "online" && health && !health.ffmpeg_ok && (
          <section className="preflight-banner" role="alert">
            <div className="preflight-banner-body">
              <AlertTriangle size={18} color="#f43f5e" style={{ flexShrink: 0, marginTop: 2 }} />
              <div>
                <p className="preflight-banner-title">FFmpeg is missing from PATH</p>
                <p className="preflight-banner-text">
                  Install FFmpeg before splitting non-WAV audio or video files:
                  <code className="preflight-code">winget install Gyan.FFmpeg</code>
                </p>
              </div>
            </div>
            <button
              type="button"
              className="studio-btn"
              onClick={() => void probeSidecar(false)}
            >
              Cek Lagi
            </button>
          </section>
        )}

        {connection === "offline" && (
          <section className="preflight-banner" role="alert">
            <div className="preflight-banner-body">
              <AlertTriangle size={18} color="#f43f5e" style={{ flexShrink: 0, marginTop: 2 }} />
              <div>
                <p className="preflight-banner-title">Python sidecar is offline</p>
                <p className="preflight-banner-text">
                  {errorDetail ?? "Unable to reach the local inference server."}
                </p>
              </div>
            </div>
            <button
              type="button"
              className="studio-btn"
              onClick={() => void probeSidecar(false)}
            >
              Retry
            </button>
          </section>
        )}

        <section className="workspace-card">
          <div className="dropzone-shell">
            <div className="dropzone-icon">
              <UploadCloud size={22} />
            </div>
            <h1 className="dropzone-title">Drop an audio or video file here</h1>
            <p className="dropzone-subtitle">
              Phase 0 environment ready · Audio ingest &amp; separation pipeline activates in Phase 1
            </p>
          </div>

          <div>
            <h2 className="presets-section-title">Curated Separation Models</h2>
            <div className="preset-grid">
              {models.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={`preset-card ${selectedPreset === preset.id ? "selected" : ""}`}
                  onClick={() => setSelectedPreset(preset.id)}
                >
                  <div className="preset-card-top">
                    <span className="preset-stems-pill">{preset.stems_count} Stems</span>
                    <span className="preset-size-text">~{preset.size_mb} MB</span>
                  </div>
                  <div className="preset-label">{preset.label}</div>
                  <div className={`preset-cache-state ${preset.is_downloaded ? "cached" : ""}`}>
                    {preset.is_downloaded ? "Cached on disk" : "Downloads on first run"}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="phase-footer-note">
            <span>Sidecar: {sidecarUrl || "Resolving…"}</span>
            <span>
              {health?.vram_mb ? `VRAM: ${health.vram_mb} MiB` : "VRAM: N/A"} ·{" "}
              {health?.ffmpeg_ok ? "FFmpeg Ready" : "FFmpeg Pending"}
            </span>
          </div>
        </section>
      </main>
    </div>
  );
}
