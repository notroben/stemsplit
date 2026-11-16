import { useEffect, useState } from "react";
import { Loader2, XCircle } from "lucide-react";
import type { SeparationEvent, SeparationStage } from "../lib/sidecar";
import { formatDuration } from "./DropZone";

interface ProgressPanelProps {
  sourceName: string;
  presetLabel: string;
  event: SeparationEvent | null;
  cancelling: boolean;
  onCancel: () => void;
}

const STAGE_TITLES: Record<SeparationStage, string> = {
  queued: "Queued for separation…",
  probing: "Probing & normalizing audio…",
  loading_model: "Preparing AI model…",
  separating: "Separating stems…",
  finalizing: "Finalizing WAV stems…",
  completed: "Separation complete",
  failed: "Separation failed",
  cancelled: "Separation cancelled",
};

export function ProgressPanel({
  sourceName,
  presetLabel,
  event,
  cancelling,
  onCancel,
}: ProgressPanelProps) {
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    setElapsedSec(0);
    const timer = window.setInterval(() => {
      setElapsedSec((prev) => prev + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [sourceName, presetLabel]);

  const stage = event?.stage ?? "queued";
  const percent = Math.min(100, Math.max(0, event?.percent ?? 0));
  const detailMessage = event?.message || STAGE_TITLES[stage];
  const disableCancel = cancelling || stage === "finalizing" || stage === "completed";

  return (
    <section className="workspace-card progress-card">
      <div className="progress-header">
        <div className="progress-title-group">
          <div className="progress-spinner">
            <Loader2 size={20} className="spin-icon" />
          </div>
          <div>
            <h1 className="progress-song-name" title={sourceName}>
              {sourceName}
            </h1>
            <p className="progress-preset-label">{presetLabel}</p>
          </div>
        </div>
        <div className="progress-timer" aria-label="Elapsed time">
          {formatDuration(elapsedSec)}
        </div>
      </div>

      <div className="progress-meter-block">
        <div className="progress-stage-row">
          <span className="progress-stage-text">{detailMessage}</span>
          <span className="progress-percent-readout">{percent}%</span>
        </div>
        <div className="progress-track" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
          <div className="progress-fill" style={{ width: `${percent}%` }} />
        </div>
      </div>

      <div className="progress-actions">
        <button
          type="button"
          className="studio-btn danger cancel-btn"
          onClick={onCancel}
          disabled={disableCancel}
        >
          <XCircle size={14} />
          <span className="stacked-label-cell">
            <span className={!cancelling ? "label-visible" : "label-hidden"}>Cancel</span>
            <span className={cancelling ? "label-visible" : "label-hidden"}>Cancelling…</span>
          </span>
        </button>
      </div>
    </section>
  );
}
