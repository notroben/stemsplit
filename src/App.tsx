import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, AudioWaveform, RefreshCw } from "lucide-react";
import { DropZone } from "./components/DropZone";
import { MixerView } from "./components/MixerView";
import { ProgressPanel } from "./components/ProgressPanel";
import {
  cancelSeparation,
  getHealth,
  getJobManifest,
  getModels,
  getSidecarUrl,
  startSeparation,
  subscribeToJobEvents,
  type HealthResponse,
  type JobManifest,
  type ModelPreset,
  type SeparationEvent,
} from "./lib/sidecar";

type ConnectionState = "connecting" | "online" | "offline";
type ViewState = "idle" | "processing" | "mixer";

interface ActiveJobInfo {
  jobId: string;
  filePath: string;
  presetId: string;
  sourceName: string;
  presetLabel: string;
}

const MAX_BOOT_ATTEMPTS = 15;
const BOOT_RETRY_MS = 400;

export default function App() {
  const [sidecarUrl, setSidecarUrl] = useState<string>("");
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [models, setModels] = useState<ModelPreset[]>([]);
  const [selectedPreset, setSelectedPreset] = useState<string>("roformer_2stem");
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const [view, setView] = useState<ViewState>("idle");
  const [activeJob, setActiveJob] = useState<ActiveJobInfo | null>(null);
  const [jobEvent, setJobEvent] = useState<SeparationEvent | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [activeManifest, setActiveManifest] = useState<JobManifest | null>(null);
  const [jobNotice, setJobNotice] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [lastAttempt, setLastAttempt] = useState<{
    filePath: string;
    presetId: string;
    sourceName: string;
  } | null>(null);

  const unsubscribeRef = useRef<(() => void) | null>(null);

  const probeSidecar = useCallback(async (withBootRetry: boolean) => {
    setConnection("connecting");
    setConnectionError(null);

    const url = await getSidecarUrl();
    setSidecarUrl(url);

    const attempts = withBootRetry ? MAX_BOOT_ATTEMPTS : 1;
    for (let i = 0; i < attempts; i += 1) {
      try {
        const [healthData, modelList] = await Promise.all([getHealth(url), getModels(url)]);
        setHealth(healthData);
        setModels(modelList);
        setConnection("online");
        return;
      } catch (err) {
        if (i === attempts - 1) {
          setConnection("offline");
          setConnectionError(err instanceof Error ? err.message : "Sidecar unreachable");
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, BOOT_RETRY_MS));
      }
    }
  }, []);

  useEffect(() => {
    void probeSidecar(true);
    return () => {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    };
  }, [probeSidecar]);

  const handleStartSeparation = useCallback(
    async (filePath: string, presetId: string, sourceName: string) => {
      const url = sidecarUrl || (await getSidecarUrl());
      const presetLabel = models.find((m) => m.id === presetId)?.label ?? presetId;

      unsubscribeRef.current?.();
      unsubscribeRef.current = null;

      setJobNotice(null);
      setActiveManifest(null);
      setCancelling(false);
      setLastAttempt({ filePath, presetId, sourceName });
      setJobEvent({ stage: "queued", percent: 0, message: "Queued for separation…" });
      setView("processing");

      try {
        const { job_id } = await startSeparation(filePath, presetId, url);
        setActiveJob({ jobId: job_id, filePath, presetId, sourceName, presetLabel });

        unsubscribeRef.current = subscribeToJobEvents(
          job_id,
          url,
          (event) => {
            setJobEvent(event);

            if (event.stage === "completed") {
              unsubscribeRef.current = null;
              void Promise.all([getJobManifest(job_id, url), getModels(url)])
                .then(([manifest, updatedModels]) => {
                  setModels(updatedModels);
                  setActiveManifest(manifest);
                  setActiveJob(null);
                  setView("mixer");
                })
                .catch((err) => {
                  setActiveJob(null);
                  setView("idle");
                  setJobNotice({
                    kind: "error",
                    text: err instanceof Error ? err.message : "Failed to load completed job manifest.",
                  });
                });
            } else if (event.stage === "cancelled") {
              unsubscribeRef.current = null;
              setActiveJob(null);
              setCancelling(false);
              setView("idle");
              setJobNotice({ kind: "info", text: "Separation cancelled and partial files cleaned up." });
            } else if (event.stage === "failed") {
              unsubscribeRef.current = null;
              setActiveJob(null);
              setCancelling(false);
              setView("idle");
              setJobNotice({ kind: "error", text: event.message || "Separation failed." });
            }
          },
          (streamErr) => {
            unsubscribeRef.current = null;
            setActiveJob(null);
            setCancelling(false);
            setView("idle");
            setJobNotice({ kind: "error", text: streamErr });
          }
        );
      } catch (err) {
        setActiveJob(null);
        setView("idle");
        setJobNotice({
          kind: "error",
          text: err instanceof Error ? err.message : "Could not start separation job.",
        });
      }
    },
    [models, sidecarUrl]
  );

  const handleCancelJob = useCallback(async () => {
    if (!activeJob || cancelling) {
      return;
    }
    setCancelling(true);
    try {
      await cancelSeparation(activeJob.jobId, sidecarUrl || undefined);
    } catch (err) {
      setCancelling(false);
      setJobNotice({
        kind: "error",
        text: err instanceof Error ? err.message : "Failed to send cancel signal.",
      });
    }
  }, [activeJob, cancelling, sidecarUrl]);

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
        <div className="hardware-badge" title={connectionError ?? "Sidecar offline"}>
          <span className="hardware-dot error" />
          <span>Sidecar Offline</span>
        </div>
      );
    }

    if (health.device === "cuda") {
      const label = health.gpu_name ? `GPU: ${health.gpu_name} (CUDA)` : "GPU Mode (CUDA)";
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
      <div className="hardware-badge" title="Running on CPU — separation may take a few minutes">
        <span className="hardware-dot warn" />
        <span>CPU Mode (Slower)</span>
      </div>
    );
  };

  const pipelineDisabled = connection !== "online" || !health?.ffmpeg_ok;

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
            disabled={connection === "connecting" || view === "processing"}
          >
            <RefreshCw size={13} />
            <span>Check</span>
          </button>
        </div>
      </header>

      <main className={`studio-main ${view === "mixer" ? "mixer-mode" : ""}`}>
        {connection === "online" && health && !health.ffmpeg_ok && view !== "mixer" && (
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
            <button type="button" className="studio-btn" onClick={() => void probeSidecar(false)}>
              Cek Lagi
            </button>
          </section>
        )}

        {connection === "offline" && view !== "mixer" && (
          <section className="preflight-banner" role="alert">
            <div className="preflight-banner-body">
              <AlertTriangle size={18} color="#f43f5e" style={{ flexShrink: 0, marginTop: 2 }} />
              <div>
                <p className="preflight-banner-title">Python sidecar is offline</p>
                <p className="preflight-banner-text">
                  {connectionError ?? "Unable to reach the local inference server."}
                </p>
              </div>
            </div>
            <button type="button" className="studio-btn" onClick={() => void probeSidecar(false)}>
              Retry
            </button>
          </section>
        )}

        {connection === "online" && health?.device === "cpu" && view === "idle" && (
          <section className="preflight-banner warn-banner" role="status">
            <div className="preflight-banner-body">
              <AlertTriangle size={18} color="#f59e0b" style={{ flexShrink: 0, marginTop: 2 }} />
              <div>
                <p className="preflight-banner-title">Running on CPU</p>
                <p className="preflight-banner-text">
                  No CUDA/MPS GPU detected — stem separation may take a few minutes per track.
                </p>
              </div>
            </div>
          </section>
        )}

        {jobNotice && view === "idle" && (
          <section
            className={`preflight-banner ${jobNotice.kind === "info" ? "info-banner" : ""}`}
            role="alert"
          >
            <div className="preflight-banner-body">
              <AlertTriangle
                size={18}
                color={jobNotice.kind === "info" ? "#2dd4bf" : "#f43f5e"}
                style={{ flexShrink: 0, marginTop: 2 }}
              />
              <div>
                <p className="preflight-banner-title">
                  {jobNotice.kind === "info" ? "Separation cancelled" : "Separation error"}
                </p>
                <p className="preflight-banner-text">{jobNotice.text}</p>
              </div>
            </div>
            <div className="banner-actions">
              {jobNotice.kind === "error" && lastAttempt && !pipelineDisabled && (
                <button
                  type="button"
                  className="studio-btn"
                  onClick={() =>
                    void handleStartSeparation(
                      lastAttempt.filePath,
                      lastAttempt.presetId,
                      lastAttempt.sourceName
                    )
                  }
                >
                  Retry
                </button>
              )}
              <button
                type="button"
                className="studio-btn"
                onClick={() => setJobNotice(null)}
              >
                Dismiss
              </button>
            </div>
          </section>
        )}

        {view === "idle" && (
          <DropZone
            sidecarUrl={sidecarUrl}
            models={models}
            selectedPreset={selectedPreset}
            disabled={pipelineDisabled}
            onSelectPreset={setSelectedPreset}
            onStartSeparation={(filePath, presetId, sourceName) =>
              void handleStartSeparation(filePath, presetId, sourceName)
            }
          />
        )}

        {view === "processing" && activeJob && (
          <ProgressPanel
            sourceName={activeJob.sourceName}
            presetLabel={activeJob.presetLabel}
            event={jobEvent}
            cancelling={cancelling}
            onCancel={() => void handleCancelJob()}
          />
        )}

        {view === "mixer" && activeManifest && (
          <MixerView
            manifest={activeManifest}
            sidecarUrl={sidecarUrl}
            onBack={() => {
              setActiveManifest(null);
              setView("idle");
            }}
          />
        )}
      </main>
    </div>
  );
}
