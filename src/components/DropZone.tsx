import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { AlertTriangle, FileAudio, FolderOpen, Sparkles, UploadCloud } from "lucide-react";
import { probeFile, type ModelPreset, type ProbeResponse } from "../lib/sidecar";

const SUPPORTED_EXTENSIONS = ["mp3", "wav", "flac", "m4a", "aac", "ogg", "mp4", "mkv", "mov"];
const LONG_DURATION_THRESHOLD_SEC = 900;

interface SelectedAudioFile {
  path: string;
  extension: string;
  probe: ProbeResponse;
}

interface DropZoneProps {
  sidecarUrl: string;
  models: ModelPreset[];
  selectedPreset: string;
  disabled: boolean;
  onSelectPreset: (presetId: string) => void;
  onStartSeparation: (filePath: string, presetId: string, sourceName: string) => void;
}

export function formatDuration(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const mins = Math.floor(clamped / 60);
  const secs = clamped % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function DropZone({
  sidecarUrl,
  models,
  selectedPreset,
  disabled,
  onSelectPreset,
  onStartSeparation,
}: DropZoneProps) {
  const [isDragHover, setIsDragHover] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<SelectedAudioFile | null>(null);
  const [longDurationConfirmed, setLongDurationConfirmed] = useState(false);

  const inspectSelectedPath = useCallback(
    async (filePath: string) => {
      const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
      if (!SUPPORTED_EXTENSIONS.includes(ext)) {
        setProbeError(
          `Unsupported file format ".${ext || "unknown"}". Supported: ${SUPPORTED_EXTENSIONS.join(", ")}.`
        );
        return;
      }

      setProbing(true);
      setProbeError(null);
      setLongDurationConfirmed(false);

      try {
        const probe = await probeFile(filePath, sidecarUrl || undefined);
        setSelectedFile({ path: filePath, extension: ext.toUpperCase(), probe });
      } catch (err) {
        setSelectedFile(null);
        setProbeError(err instanceof Error ? err.message : "Failed to inspect audio file.");
      } finally {
        setProbing(false);
      }
    },
    [sidecarUrl]
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let mounted = true;

    const attachDropListener = async () => {
      try {
        const fn = await getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type === "enter") {
            setIsDragHover(true);
          } else if (event.payload.type === "leave") {
            setIsDragHover(false);
          } else if (event.payload.type === "drop") {
            setIsDragHover(false);
            if (!disabled && event.payload.paths.length > 0) {
              void inspectSelectedPath(event.payload.paths[0]);
            }
          }
        });
        if (mounted) {
          unlisten = fn;
        } else {
          fn();
        }
      } catch {
        // Ignore when running outside Tauri webview during browser preview.
      }
    };

    void attachDropListener();
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, [disabled, inspectSelectedPath]);

  const handleBrowseFile = async () => {
    if (disabled || probing) {
      return;
    }
    try {
      const picked = await open({
        title: "Select Audio or Video File",
        multiple: false,
        filters: [
          {
            name: "Audio & Video Files",
            extensions: SUPPORTED_EXTENSIONS,
          },
        ],
      });
      if (typeof picked === "string") {
        await inspectSelectedPath(picked);
      }
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : "Failed to open file dialog.");
    }
  };

  const isLongFile =
    selectedFile !== null && selectedFile.probe.duration_sec > LONG_DURATION_THRESHOLD_SEC;
  const canStart =
    !disabled &&
    !probing &&
    selectedFile !== null &&
    (!isLongFile || longDurationConfirmed);

  return (
    <section className="workspace-card">
      <div
        className={`dropzone-shell ${isDragHover ? "drag-hover" : ""} ${selectedFile ? "has-file" : ""}`}
        onClick={() => {
          if (!selectedFile) {
            void handleBrowseFile();
          }
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !selectedFile) {
            e.preventDefault();
            void handleBrowseFile();
          }
        }}
      >
        {selectedFile ? (
          <div className="selected-file-summary">
            <div className="selected-file-meta">
              <div className="dropzone-icon">
                <FileAudio size={22} />
              </div>
              <div className="selected-file-text">
                <div className="selected-file-name" title={selectedFile.path}>
                  {selectedFile.probe.source_name}
                </div>
                <div className="selected-file-details">
                  <span className="format-pill">{selectedFile.extension}</span>
                  <span>Duration: {formatDuration(selectedFile.probe.duration_sec)}</span>
                  <span>{(selectedFile.probe.sample_rate / 1000).toFixed(1)} kHz</span>
                  <span>{selectedFile.probe.channels === 1 ? "Mono" : "Stereo"}</span>
                </div>
              </div>
            </div>
            <button
              type="button"
              className="studio-btn"
              onClick={(e) => {
                e.stopPropagation();
                void handleBrowseFile();
              }}
              disabled={disabled || probing}
            >
              <FolderOpen size={14} />
              <span>Change File</span>
            </button>
          </div>
        ) : (
          <>
            <div className="dropzone-icon">
              <UploadCloud size={22} />
            </div>
            <h1 className="dropzone-title">
              {probing ? "Inspecting audio file…" : "Drop an audio or video file here"}
            </h1>
            <p className="dropzone-subtitle">
              Supports MP3, WAV, FLAC, M4A, AAC, OGG, MP4, MKV, MOV
            </p>
            <button
              type="button"
              className="studio-btn"
              onClick={(e) => {
                e.stopPropagation();
                void handleBrowseFile();
              }}
              disabled={disabled || probing}
            >
              <FolderOpen size={14} />
              <span>Browse File</span>
            </button>
          </>
        )}
      </div>

      {probeError && (
        <div className="inline-alert error" role="alert">
          <AlertTriangle size={16} />
          <span>{probeError}</span>
        </div>
      )}

      {isLongFile && (
        <div className="inline-alert warn" role="alert">
          <AlertTriangle size={16} />
          <div className="long-file-warning">
            <span>
              This track is {formatDuration(selectedFile.probe.duration_sec)} long (&gt;15 min).
              Separation and mixer PCM buffering will take longer and use more memory.
            </span>
            <label className="confirm-checkbox">
              <input
                type="checkbox"
                checked={longDurationConfirmed}
                onChange={(e) => setLongDurationConfirmed(e.target.checked)}
              />
              <span>I understand — continue with separation</span>
            </label>
          </div>
        </div>
      )}

      <div>
        <h2 className="presets-section-title">Curated Separation Models</h2>
        <div className="preset-grid">
          {models.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`preset-card ${selectedPreset === preset.id ? "selected" : ""}`}
              onClick={() => onSelectPreset(preset.id)}
            >
              <div className="preset-card-top">
                <span className="preset-stems-pill">{preset.stems_count} Stems</span>
                <span className="preset-size-text">~{preset.size_mb} MB</span>
              </div>
              <div className="preset-label">{preset.label}</div>
              <div className={`preset-cache-state ${preset.is_downloaded ? "cached" : ""}`}>
                {preset.is_downloaded ? "Cached on disk" : "One-time download"}
              </div>
            </button>
          ))}
        </div>
        {selectedPreset === "htdemucs_6stem" && (
          <p className="preset-caveat">
            Note: 6-stem Guitar and Piano stems can have slightly more mutual bleed than the 4-stem split.
          </p>
        )}
      </div>

      <div className="workspace-actions">
        <button
          type="button"
          className="primary-action-btn"
          disabled={!canStart}
          onClick={() => {
            if (selectedFile) {
              onStartSeparation(selectedFile.path, selectedPreset, selectedFile.probe.source_name);
            }
          }}
        >
          <Sparkles size={15} />
          <span>Split Stems</span>
        </button>
      </div>
    </section>
  );
}
