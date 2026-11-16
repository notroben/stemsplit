import { useEffect, useState } from "react";
import { Check, Copy, Smartphone, Wifi, WifiOff, X } from "lucide-react";
import type { LanStatus } from "../lib/sidecar";

interface LanModalProps {
  status: LanStatus | null;
  busy: boolean;
  error: string | null;
  onToggle: (enabled: boolean) => void;
  onClose: () => void;
}

export function LanModal({
  status,
  busy,
  error,
  onToggle,
  onClose,
}: LanModalProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  const enabled = status?.enabled ?? false;
  const url = status?.url ?? null;

  const handleCopy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard API unavailable; user can select the visible URL text directly.
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="lan-modal-title"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div className="modal-card lan-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="lan-modal-title-row">
            <div className="studio-brand-mark">
              <Smartphone size={17} />
            </div>
            <div>
              <h2 id="lan-modal-title" className="modal-title">
                Mobile Companion (Wi-Fi)
              </h2>
              <p className="modal-subtitle">
                Upload, split on PC GPU, and download stems from your phone
              </p>
            </div>
          </div>
          <button
            type="button"
            className="studio-btn icon-only-btn"
            onClick={onClose}
            disabled={busy}
            aria-label="Close LAN modal"
          >
            <X size={15} />
          </button>
        </div>

        <div className="lan-status-banner">
          <div className="lan-status-left">
            <span className={`hardware-dot ${enabled ? "ok" : "warn"}`} />
            <span className="lan-status-text">
              {enabled ? `Active on Wi-Fi (0.0.0.0:${status?.port ?? 7860})` : "Disabled — Localhost Only"}
            </span>
          </div>
          {enabled ? <Wifi size={15} color="#10b981" /> : <WifiOff size={15} color="#9ca3af" />}
        </div>

        {enabled && url && status?.qr_svg ? (
          <div className="lan-qr-section">
            <div
              className="qr-frame"
              aria-label={`QR code for ${url}`}
              dangerouslySetInnerHTML={{ __html: status.qr_svg }}
            />
            <div className="lan-url-row">
              <code className="lan-url-code">{url}</code>
              <button type="button" className="studio-btn" onClick={() => void handleCopy()}>
                {copied ? <Check size={13} color="#10b981" /> : <Copy size={13} />}
                <span>{copied ? "Copied" : "Copy Link"}</span>
              </button>
            </div>
            <p className="lan-hint">
              Scan this QR code with your phone on the same Wi-Fi network. If Windows Firewall
              prompts, allow access on your Private network.
            </p>
          </div>
        ) : (
          <p className="lan-hint">
            When enabled, StemSplit binds an auxiliary listener on your local Wi-Fi IP so phones on
            the same router can submit tracks to your GPU without cloud uploads.
          </p>
        )}

        {error && (
          <div className="inline-alert error" role="alert">
            <span>{error}</span>
          </div>
        )}

        <div className="modal-footer-actions">
          {enabled ? (
            <button
              type="button"
              className="studio-btn danger"
              disabled={busy}
              onClick={() => onToggle(false)}
            >
              <WifiOff size={14} />
              <span>{busy ? "Stopping…" : "Turn Off Mobile Companion"}</span>
            </button>
          ) : (
            <button
              type="button"
              className="primary-action-btn"
              disabled={busy}
              onClick={() => onToggle(true)}
            >
              <Wifi size={14} />
              <span>{busy ? "Starting…" : "Enable Mobile Companion (Wi-Fi)"}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
