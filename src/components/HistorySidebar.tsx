import { useEffect, useState } from "react";
import { Disc3, PanelLeftClose, Trash2 } from "lucide-react";
import type { JobManifest } from "../lib/sidecar";
import { formatDuration } from "./DropZone";

interface HistorySidebarProps {
  open: boolean;
  jobs: JobManifest[];
  totalCacheBytes: number;
  activeJobId: string | null;
  disabled: boolean;
  onClose: () => void;
  onSelectJob: (job: JobManifest) => void;
  onDeleteJob: (jobId: string) => Promise<void> | void;
  onPurgeAll: () => Promise<void> | void;
}

export function formatCacheSize(bytes: number): string {
  if (bytes <= 0) return "0 MB";
  const gb = 1024 * 1024 * 1024;
  const mb = 1024 * 1024;
  if (bytes >= gb) {
    return `${(bytes / gb).toFixed(2)} GB`;
  }
  if (bytes >= mb) {
    return `${(bytes / mb).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function HistorySidebar({
  open,
  jobs,
  totalCacheBytes,
  activeJobId,
  disabled,
  onClose,
  onSelectJob,
  onDeleteJob,
  onPurgeAll,
}: HistorySidebarProps) {
  const [confirmPurge, setConfirmPurge] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || jobs.length === 0) {
      setConfirmPurge(false);
    }
  }, [open, jobs.length]);

  if (!open) {
    return null;
  }

  const handleDeleteClick = async (e: React.MouseEvent, jobId: string) => {
    e.stopPropagation();
    if (disabled || busy) return;
    setBusy(true);
    try {
      await onDeleteJob(jobId);
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmPurge = async () => {
    if (disabled || busy) return;
    setBusy(true);
    try {
      await onPurgeAll();
      setConfirmPurge(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="history-sidebar" aria-label="Separation history">
      <div className="history-header">
        <div className="history-header-title">
          <span>History</span>
          <span className="history-count-pill">{jobs.length}</span>
        </div>
        <button
          type="button"
          className="studio-btn icon-only-btn"
          onClick={onClose}
          title="Collapse history drawer"
          aria-label="Collapse history drawer"
        >
          <PanelLeftClose size={14} />
        </button>
      </div>

      <div className="history-list">
        {jobs.length === 0 ? (
          <div className="history-empty">
            <Disc3 size={22} color="#6b7280" />
            <p className="history-empty-title">No cached separations</p>
            <p className="history-empty-sub">
              Split tracks are saved locally so you can reopen them instantly.
            </p>
          </div>
        ) : (
          jobs.map((job) => {
            const isActive = job.id === activeJobId;
            return (
              <div
                key={job.id}
                role="button"
                tabIndex={disabled ? -1 : 0}
                aria-disabled={disabled}
                className={`history-item ${isActive ? "active" : ""} ${disabled ? "disabled" : ""}`}
                onClick={() => {
                  if (!disabled && !busy) {
                    onSelectJob(job);
                  }
                }}
                onKeyDown={(e) => {
                  if ((e.key === "Enter" || e.key === " ") && !disabled && !busy) {
                    e.preventDefault();
                    onSelectJob(job);
                  }
                }}
              >
                <div className="history-item-main">
                  <div className="history-item-title" title={job.source_name}>
                    {job.source_name}
                  </div>
                  <div className="history-item-meta">
                    <span className="history-stems-tag">{job.stems.length} Stems</span>
                    <span>{formatDuration(job.duration_sec)}</span>
                    <span>·</span>
                    <span>{formatCacheSize(job.size_bytes ?? 0)}</span>
                  </div>
                </div>
                <button
                  type="button"
                  className="history-delete-btn"
                  disabled={disabled || busy}
                  onClick={(e) => void handleDeleteClick(e, job.id)}
                  title={`Delete ${job.source_name}`}
                  aria-label={`Delete ${job.source_name}`}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })
        )}
      </div>

      <div className="history-footer">
        <div className="history-cache-readout">
          Cache: {formatCacheSize(totalCacheBytes)} across {jobs.length}{" "}
          {jobs.length === 1 ? "song" : "songs"}
        </div>

        {confirmPurge ? (
          <div className="history-purge-confirm">
            <button
              type="button"
              className="studio-btn danger history-purge-action"
              disabled={disabled || busy || jobs.length === 0}
              onClick={() => void handleConfirmPurge()}
            >
              Yakin Hapus Semua?
            </button>
            <button
              type="button"
              className="studio-btn"
              disabled={busy}
              onClick={() => setConfirmPurge(false)}
            >
              Batal
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="studio-btn danger history-purge-btn"
            disabled={disabled || busy || jobs.length === 0}
            onClick={() => setConfirmPurge(true)}
          >
            <Trash2 size={13} />
            <span>Bersihkan Semua Cache</span>
          </button>
        )}
      </div>
    </aside>
  );
}
