import { useEffect, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { CheckCircle2, Download, FolderOpen, FileArchive, X } from "lucide-react";
import type { StemChannelState } from "../lib/audio-engine";
import {
  exportMix,
  openJobFolder,
  type ExportFormat,
  type ExportResponse,
  type JobManifest,
} from "../lib/sidecar";

interface ExportModalProps {
  manifest: JobManifest;
  sidecarUrl: string;
  stemStates: Record<string, StemChannelState>;
  onClose: () => void;
}

type ExportTab = "mix" | "stems";

const FORMAT_OPTIONS: { id: ExportFormat; label: string; detail: string }[] = [
  { id: "mp3", label: "MP3", detail: "320 kbps CBR" },
  { id: "wav", label: "WAV", detail: "16-bit PCM" },
  { id: "flac", label: "FLAC", detail: "Lossless" },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function getBaseTrackName(sourceName: string): string {
  const idx = sourceName.lastIndexOf(".");
  return idx > 0 ? sourceName.slice(0, idx) : sourceName;
}

export function ExportModal({
  manifest,
  sidecarUrl,
  stemStates,
  onClose,
}: ExportModalProps) {
  const [tab, setTab] = useState<ExportTab>("mix");
  const [format, setFormat] = useState<ExportFormat>("mp3");
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<ExportResponse | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !exporting) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [exporting, onClose]);

  const anySoloed = manifest.stems.some((s) => stemStates[s.id]?.soloed);
  const effectiveStems = manifest.stems.map((stem) => {
    const st = stemStates[stem.id] ?? { volume: 1.0, muted: false, soloed: false };
    const audible = !st.muted && (!anySoloed || st.soloed) && st.volume > 0;
    return {
      stem,
      state: st,
      audible,
    };
  });
  const activeCount = effectiveStems.filter((item) => item.audible).length;
  const baseName = getBaseTrackName(manifest.source_name);

  const runCustomMixExport = async () => {
    if (exporting || activeCount === 0) return;
    setError(null);
    setSaved(null);

    try {
      const targetPath = await save({
        title: "Export Custom Mix",
        defaultPath: `${baseName} (Custom Mix).${format}`,
        filters: [{ name: `${format.toUpperCase()} Audio`, extensions: [format] }],
      });
      if (!targetPath) return;

      setExporting(true);
      const res = await exportMix(
        {
          job_id: manifest.id,
          target_path: targetPath,
          format,
          mode: "custom_mix",
          stems: manifest.stems.map((s) => {
            const st = stemStates[s.id] ?? { volume: 1.0, muted: false, soloed: false };
            return {
              id: s.id,
              volume: st.volume,
              muted: st.muted,
              soloed: st.soloed,
            };
          }),
        },
        sidecarUrl || undefined
      );
      setSaved(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to export custom mix.");
    } finally {
      setExporting(false);
    }
  };

  const runSingleStemExport = async (stemId: string, label: string) => {
    if (exporting) return;
    setError(null);
    setSaved(null);

    try {
      const targetPath = await save({
        title: `Save ${label} Stem`,
        defaultPath: `${baseName} - ${label}.${format}`,
        filters: [{ name: `${format.toUpperCase()} Audio`, extensions: [format] }],
      });
      if (!targetPath) return;

      setExporting(true);
      const res = await exportMix(
        {
          job_id: manifest.id,
          target_path: targetPath,
          format,
          mode: "single_stem",
          stems: [{ id: stemId, volume: 1.0, muted: false, soloed: false }],
        },
        sidecarUrl || undefined
      );
      setSaved(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to export ${label}.`);
    } finally {
      setExporting(false);
    }
  };

  const runBatchExport = async (asZip: boolean) => {
    if (exporting) return;
    setError(null);
    setSaved(null);

    try {
      const targetPath = asZip
        ? await save({
            title: "Export All Stems as ZIP",
            defaultPath: `${baseName} - Stems.zip`,
            filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
          })
        : await open({
            title: "Choose Folder for All Stems",
            directory: true,
            multiple: false,
          });

      if (typeof targetPath !== "string" || !targetPath) return;

      setExporting(true);
      const res = await exportMix(
        {
          job_id: manifest.id,
          target_path: targetPath,
          format,
          mode: asZip ? "all_stems_zip" : "all_stems_folder",
          stems: [],
        },
        sidecarUrl || undefined
      );
      setSaved(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to export stems.");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-modal-title"
      onClick={() => {
        if (!exporting) onClose();
      }}
    >
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2 id="export-modal-title" className="modal-title">
              Export Audio
            </h2>
            <p className="modal-subtitle" title={manifest.source_name}>
              {manifest.source_name}
            </p>
          </div>
          <button
            type="button"
            className="studio-btn icon-only-btn"
            onClick={onClose}
            disabled={exporting}
            aria-label="Close export dialog"
          >
            <X size={15} />
          </button>
        </div>

        <div className="export-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "mix"}
            className={`export-tab-btn ${tab === "mix" ? "active" : ""}`}
            onClick={() => {
              setTab("mix");
              setError(null);
            }}
          >
            Custom Mix (&ldquo;What You Hear&rdquo;)
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "stems"}
            className={`export-tab-btn ${tab === "stems" ? "active" : ""}`}
            onClick={() => {
              setTab("stems");
              setError(null);
            }}
          >
            Individual Stems &amp; Batch
          </button>
        </div>

        <div className="format-selector-row">
          <span className="format-label">Output Format</span>
          <div className="format-pills">
            {FORMAT_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={`format-pill-btn ${format === opt.id ? "selected" : ""}`}
                onClick={() => setFormat(opt.id)}
                disabled={exporting}
              >
                <span className="format-pill-name">{opt.label}</span>
                <span className="format-pill-detail">{opt.detail}</span>
              </button>
            ))}
          </div>
        </div>

        {tab === "mix" ? (
          <div className="export-panel-body">
            <div className="mix-summary-list">
              {effectiveStems.map(({ stem, state, audible }) => (
                <div key={stem.id} className={`mix-summary-row ${!audible ? "inactive" : ""}`}>
                  <div className="stem-output-left">
                    <span className="stem-color-dot" style={{ backgroundColor: stem.color }} />
                    <span className="stem-output-label">{stem.label}</span>
                  </div>
                  <span className="mix-summary-gain">
                    {audible
                      ? `${Math.round(state.volume * 100)}%${state.soloed ? " · Solo" : ""}`
                      : state.muted
                        ? "Muted"
                        : "Inactive"}
                  </span>
                </div>
              ))}
            </div>

            {activeCount === 0 && (
              <p className="inline-alert warn">
                All stems are muted or at 0%. Unmute at least one stem to export a custom mix.
              </p>
            )}

            <div className="modal-footer-actions">
              <button
                type="button"
                className="primary-action-btn"
                disabled={exporting || activeCount === 0}
                onClick={() => void runCustomMixExport()}
              >
                <Download size={15} />
                <span>{exporting ? "Rendering Mix…" : `Export Mix (.${format})`}</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="export-panel-body">
            <div className="mix-summary-list">
              {manifest.stems.map((stem) => (
                <div key={stem.id} className="mix-summary-row">
                  <div className="stem-output-left">
                    <span className="stem-color-dot" style={{ backgroundColor: stem.color }} />
                    <span className="stem-output-label">{stem.label}</span>
                  </div>
                  <button
                    type="button"
                    className="studio-btn"
                    disabled={exporting}
                    onClick={() => void runSingleStemExport(stem.id, stem.label)}
                  >
                    <Download size={13} />
                    <span>Save .{format}</span>
                  </button>
                </div>
              ))}
            </div>

            <div className="modal-footer-actions batch-actions">
              <button
                type="button"
                className="studio-btn"
                disabled={exporting}
                onClick={() => void runBatchExport(false)}
              >
                <FolderOpen size={14} />
                <span>Export All to Folder…</span>
              </button>
              <button
                type="button"
                className="primary-action-btn"
                disabled={exporting}
                onClick={() => void runBatchExport(true)}
              >
                <FileArchive size={15} />
                <span>{exporting ? "Packaging ZIP…" : "Export All as ZIP…"}</span>
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="inline-alert error" role="alert">
            <span>{error}</span>
          </div>
        )}

        {saved && (
          <div className="export-success-box">
            <div className="export-success-meta">
              <CheckCircle2 size={16} color="#10b981" style={{ flexShrink: 0 }} />
              <div className="export-success-text">
                <span className="export-success-title">
                  Exported ({formatBytes(saved.bytes)})
                </span>
                <span className="export-success-path" title={saved.saved_path}>
                  {saved.saved_path}
                </span>
              </div>
            </div>
            <button
              type="button"
              className="studio-btn"
              onClick={() => void openJobFolder(saved.saved_path)}
            >
              <FolderOpen size={13} />
              <span>Show Folder</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
