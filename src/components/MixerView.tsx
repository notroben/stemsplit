import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Download,
  FolderOpen,
  Headphones,
  Loader2,
  Pause,
  Play,
  Repeat,
  RotateCcw,
  Volume2,
} from "lucide-react";
import { MultiStemAudioEngine, type StemChannelState } from "../lib/audio-engine";
import { openJobFolder, type JobManifest } from "../lib/sidecar";
import { ExportModal } from "./ExportModal";

interface MixerViewProps {
  manifest: JobManifest;
  sidecarUrl: string;
  onBack: () => void;
}

interface StemWaveformCanvasProps {
  peaks: Float32Array | undefined;
  color: string;
  active: boolean;
  progress: number;
  duration: number;
  onSeek: (offsetSec: number) => void;
}

function formatTimeTenths(totalSeconds: number): string {
  const clamped = Math.max(0, totalSeconds);
  const mins = Math.floor(clamped / 60);
  const secs = Math.floor(clamped % 60);
  const tenths = Math.floor((clamped * 10) % 10);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${tenths}`;
}

function StemWaveformCanvas({
  peaks,
  color,
  active,
  progress,
  duration,
  onSeek,
}: StemWaveformCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const draggingRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setSize({
        width: Math.floor(entry.contentRect.width),
        height: Math.floor(entry.contentRect.height),
      });
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width <= 0 || size.height <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.floor(size.width * dpr);
    const targetH = Math.floor(size.height * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, size.width, size.height);

    const midY = size.height / 2;
    const halfH = midY - 4;
    const clampedProgress = Math.max(0, Math.min(1, progress));
    const playheadX = clampedProgress * size.width;

    // Subtle center baseline
    ctx.fillStyle = "rgba(255, 255, 255, 0.06)";
    ctx.fillRect(0, midY - 0.5, size.width, 1);

    if (peaks && peaks.length >= 2) {
      const buckets = peaks.length / 2;
      const barStep = 2;
      const barWidth = 1.5;

      for (let x = 0; x < size.width; x += barStep) {
        const bucketIdx = Math.min(buckets - 1, Math.floor((x / size.width) * buckets));
        const minVal = peaks[bucketIdx * 2];
        const maxVal = peaks[bucketIdx * 2 + 1];
        const top = midY - Math.max(0.03, maxVal) * halfH;
        const bottom = midY - Math.min(-0.03, minVal) * halfH;
        const barH = Math.max(2, bottom - top);

        const isPlayed = x <= playheadX;
        if (!active) {
          ctx.fillStyle = isPlayed ? "rgba(156, 163, 175, 0.45)" : "rgba(156, 163, 175, 0.18)";
        } else {
          ctx.globalAlpha = isPlayed ? 0.95 : 0.34;
          ctx.fillStyle = color;
        }
        ctx.fillRect(x, top, barWidth, barH);
      }
      ctx.globalAlpha = 1.0;
    }

    // Playhead cursor
    ctx.fillStyle = "#f3f4f6";
    ctx.fillRect(Math.max(0, Math.min(size.width - 2, playheadX - 1)), 2, 2, size.height - 4);
    ctx.restore();
  }, [peaks, color, active, progress, size]);

  const seekAtClientX = (clientX: number) => {
    const canvas = canvasRef.current;
    if (!canvas || duration <= 0) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    onSeek(ratio * duration);
  };

  return (
    <canvas
      ref={canvasRef}
      className="stem-waveform-canvas"
      onPointerDown={(e) => {
        draggingRef.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        seekAtClientX(e.clientX);
      }}
      onPointerMove={(e) => {
        if (draggingRef.current) {
          seekAtClientX(e.clientX);
        }
      }}
      onPointerUp={(e) => {
        draggingRef.current = false;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
      }}
    />
  );
}

export function MixerView({ manifest, sidecarUrl, onBack }: MixerViewProps) {
  const engineRef = useRef<MultiStemAudioEngine | null>(null);
  const rafRef = useRef<number | null>(null);

  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [peaksMap, setPeaksMap] = useState<Map<string, Float32Array>>(new Map());
  const [stemStates, setStemStates] = useState<Record<string, StemChannelState>>(() => {
    const init: Record<string, StemChannelState> = {};
    for (const stem of manifest.stems) {
      init[stem.id] = { volume: 1.0, muted: false, soloed: false };
    }
    return init;
  });

  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const [abOriginal, setAbOriginal] = useState(false);
  const [masterVolume, setMasterVolume] = useState(1.0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(manifest.duration_sec);
  const [exportOpen, setExportOpen] = useState(false);

  const initAudioEngine = useCallback(() => {
    engineRef.current?.dispose();
    const engine = new MultiStemAudioEngine();
    engineRef.current = engine;

    setLoadState("loading");
    setLoadError(null);
    setPlaying(false);
    setCurrentTime(0);

    engine.onEnded(() => {
      setPlaying(false);
      setCurrentTime(0);
    });

    void engine
      .loadJob(manifest)
      .then((peaks) => {
        if (engineRef.current !== engine) return;
        setPeaksMap(peaks);
        setDuration(engine.getDuration() || manifest.duration_sec);
        setLoadState("ready");
      })
      .catch((err) => {
        if (engineRef.current !== engine) return;
        setLoadError(err instanceof Error ? err.message : "Failed to decode separated audio.");
        setLoadState("error");
      });
  }, [manifest]);

  useEffect(() => {
    initAudioEngine();
    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
      }
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, [initAudioEngine]);

  useEffect(() => {
    if (!playing) {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    const tick = () => {
      if (engineRef.current) {
        setCurrentTime(engineRef.current.getCurrentTime());
      }
      rafRef.current = window.requestAnimationFrame(tick);
    };
    rafRef.current = window.requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [playing]);

  const togglePlayPause = useCallback(() => {
    const engine = engineRef.current;
    if (!engine || loadState !== "ready") return;
    if (engine.isPlaying()) {
      engine.pause();
      setPlaying(false);
      setCurrentTime(engine.getCurrentTime());
    } else {
      engine.play();
      setPlaying(true);
    }
  }, [loadState]);

  const handleSeek = useCallback(
    (offsetSec: number) => {
      const engine = engineRef.current;
      if (!engine || loadState !== "ready") return;
      engine.seek(offsetSec);
      setCurrentTime(offsetSec);
    },
    [loadState]
  );

  const handleRestart = useCallback(() => {
    handleSeek(0);
  }, [handleSeek]);

  const toggleLoop = useCallback(() => {
    setLoop((prev) => {
      const next = !prev;
      engineRef.current?.setLoop(next);
      return next;
    });
  }, []);

  const toggleAbOriginal = useCallback(() => {
    setAbOriginal((prev) => {
      const next = !prev;
      engineRef.current?.setAbOriginal(next);
      return next;
    });
  }, []);

  const updateMasterVolume = useCallback((value: number) => {
    const clamped = Math.max(0, Math.min(1.5, value));
    setMasterVolume(clamped);
    engineRef.current?.setMasterVolume(clamped);
  }, []);

  const updateStem = useCallback((stemId: string, patch: Partial<StemChannelState>) => {
    setStemStates((prev) => {
      const current = prev[stemId] ?? { volume: 1.0, muted: false, soloed: false };
      const next = { ...current, ...patch };
      engineRef.current?.setStemState(stemId, next);
      return { ...prev, [stemId]: next };
    });
  }, []);

  const toggleSolo = useCallback(
    (stemId: string) => {
      const current = stemStates[stemId] ?? { volume: 1.0, muted: false, soloed: false };
      updateStem(stemId, { soloed: !current.soloed });
    },
    [stemStates, updateStem]
  );

  const toggleMute = useCallback(
    (stemId: string) => {
      const current = stemStates[stemId] ?? { volume: 1.0, muted: false, soloed: false };
      updateStem(stemId, { muted: !current.muted });
    },
    [stemStates, updateStem]
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isInput =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "e") {
        e.preventDefault();
        if (loadState === "ready") {
          setExportOpen(true);
        }
        return;
      }

      if (exportOpen || isInput) return;

      if (e.code === "Space") {
        e.preventDefault();
        togglePlayPause();
        return;
      }

      if (e.key >= "1" && e.key <= "6") {
        const index = Number(e.key) - 1;
        const stem = manifest.stems[index];
        if (stem) {
          e.preventDefault();
          toggleSolo(stem.id);
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [exportOpen, loadState, manifest.stems, togglePlayPause, toggleSolo]);

  const anySoloed = manifest.stems.some((s) => stemStates[s.id]?.soloed);
  const progressRatio = duration > 0 ? currentTime / duration : 0;

  return (
    <div className="mixer-container">
      {/* Mixer Top Bar */}
      <div className="mixer-topbar">
        <div className="mixer-topbar-left">
          <button type="button" className="studio-btn" onClick={onBack}>
            <ArrowLeft size={14} />
            <span>Back</span>
          </button>
          <div className="mixer-track-title-wrap">
            <h1 className="mixer-track-title" title={manifest.source_name}>
              {manifest.source_name}
            </h1>
            <span className="mixer-preset-pill">{manifest.stems.length}-Stem</span>
          </div>
        </div>

        <div className="mixer-topbar-actions">
          <button
            type="button"
            className="studio-btn"
            onClick={() => void openJobFolder(manifest.original_path)}
          >
            <FolderOpen size={14} />
            <span>Folder</span>
          </button>
          <button
            type="button"
            className="primary-action-btn mixer-export-btn"
            disabled={loadState !== "ready"}
            onClick={() => setExportOpen(true)}
            title="Export stems or custom mix (Ctrl/Cmd + E)"
          >
            <Download size={14} />
            <span>Export</span>
          </button>
        </div>
      </div>

      {/* Master Transport Bar */}
      <div className="transport-bar">
        <div className="transport-controls-left">
          <button
            type="button"
            className="primary-action-btn play-pause-btn"
            disabled={loadState !== "ready"}
            onClick={togglePlayPause}
            title="Play / Pause (Space)"
          >
            {playing ? <Pause size={15} /> : <Play size={15} />}
            <span className="stacked-label-cell">
              <span className={!playing ? "label-visible" : "label-hidden"}>Play</span>
              <span className={playing ? "label-visible" : "label-hidden"}>Pause</span>
            </span>
          </button>

          <button
            type="button"
            className="studio-btn icon-only-btn"
            disabled={loadState !== "ready"}
            onClick={handleRestart}
            title="Return to start"
          >
            <RotateCcw size={14} />
          </button>

          <button
            type="button"
            className={`studio-btn toggle-btn ${loop ? "active" : ""}`}
            disabled={loadState !== "ready"}
            onClick={toggleLoop}
            title="Toggle Loop"
          >
            <Repeat size={14} />
            <span>Loop</span>
          </button>

          <button
            type="button"
            className={`studio-btn toggle-btn ab-btn ${abOriginal ? "active-amber" : ""}`}
            disabled={loadState !== "ready"}
            onClick={toggleAbOriginal}
            title="Compare against unsplit original audio"
          >
            <Headphones size={14} />
            <span>A/B Original</span>
          </button>

          <div className="transport-time-readout">
            <span>{formatTimeTenths(currentTime)}</span>
            <span className="time-divider">/</span>
            <span className="time-total">{formatTimeTenths(duration)}</span>
          </div>
        </div>

        <div className="master-volume-control">
          <Volume2 size={15} color="#9ca3af" />
          <span className="master-label">Master</span>
          <input
            type="range"
            className="studio-slider master-slider"
            min={0}
            max={150}
            value={Math.round(masterVolume * 100)}
            disabled={loadState !== "ready"}
            onChange={(e) => updateMasterVolume(Number(e.target.value) / 100)}
            onDoubleClick={() => updateMasterVolume(1.0)}
            title="Double-click to reset to 100%"
          />
          <span className="volume-readout">{Math.round(masterVolume * 100)}%</span>
        </div>
      </div>

      {/* Stem Tracks Area */}
      {loadState === "loading" && (
        <div className="mixer-loading-card">
          <Loader2 size={24} className="spin-icon" color="#2dd4bf" />
          <p className="mixer-loading-title">Decoding audio stems into Web Audio buffers…</p>
          <p className="mixer-loading-sub">Preparing sample-accurate waveforms</p>
        </div>
      )}

      {loadState === "error" && (
        <div className="mixer-loading-card">
          <AlertTriangle size={24} color="#f43f5e" />
          <p className="mixer-loading-title">Could not load stem audio buffers</p>
          <p className="mixer-loading-sub">{loadError}</p>
          <div className="banner-actions">
            <button type="button" className="studio-btn" onClick={initAudioEngine}>
              Retry Decode
            </button>
            <button type="button" className="studio-btn" onClick={onBack}>
              Back to Dropzone
            </button>
          </div>
        </div>
      )}

      {loadState === "ready" && (
        <div className="stem-tracks-scroll">
          {manifest.stems.map((stem, idx) => {
            const state = stemStates[stem.id] ?? { volume: 1.0, muted: false, soloed: false };
            const isAudible = !abOriginal && !state.muted && (!anySoloed || state.soloed);
            const pct = Math.round(state.volume * 100);

            return (
              <div
                key={stem.id}
                className={`stem-track-row ${!isAudible ? "stem-inactive" : ""}`}
              >
                <div className="stem-identity-col">
                  <div className="stem-label-line">
                    <span className="stem-color-dot" style={{ backgroundColor: stem.color }} />
                    <span className="stem-row-name">{stem.label}</span>
                    <span className="stem-key-hint">{idx + 1}</span>
                  </div>
                  <span
                    className={`stem-status-badge ${
                      abOriginal
                        ? "ab"
                        : state.soloed
                          ? "solo"
                          : state.muted
                            ? "muted"
                            : !isAudible
                              ? "muted"
                              : ""
                    }`}
                  >
                    {abOriginal
                      ? "A/B ORIG"
                      : state.soloed
                        ? "SOLO"
                        : state.muted
                          ? "MUTED"
                          : !isAudible
                            ? "SILENCED"
                            : "ACTIVE"}
                  </span>
                </div>

                <div className="stem-sm-col">
                  <button
                    type="button"
                    className={`sm-btn solo-btn ${state.soloed ? "active" : ""}`}
                    onClick={() => toggleSolo(stem.id)}
                    title={`Solo ${stem.label} (Key ${idx + 1})`}
                  >
                    S
                  </button>
                  <button
                    type="button"
                    className={`sm-btn mute-btn ${state.muted ? "active" : ""}`}
                    onClick={() => toggleMute(stem.id)}
                    title={`Mute ${stem.label}`}
                  >
                    M
                  </button>
                </div>

                <div className="stem-fader-col">
                  <input
                    type="range"
                    className="studio-slider"
                    min={0}
                    max={150}
                    value={pct}
                    style={{ accentColor: stem.color }}
                    onChange={(e) =>
                      updateStem(stem.id, { volume: Number(e.target.value) / 100 })
                    }
                    onDoubleClick={() => updateStem(stem.id, { volume: 1.0 })}
                    title="Double-click to reset to 100%"
                  />
                  <span className="volume-readout">{pct}%</span>
                </div>

                <div className="stem-waveform-col">
                  <StemWaveformCanvas
                    peaks={peaksMap.get(stem.id)}
                    color={stem.color}
                    active={isAudible && pct > 0}
                    progress={progressRatio}
                    duration={duration}
                    onSeek={handleSeek}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {exportOpen && (
        <ExportModal
          manifest={manifest}
          sidecarUrl={sidecarUrl}
          stemStates={stemStates}
          onClose={() => setExportOpen(false)}
        />
      )}
    </div>
  );
}
