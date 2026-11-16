import { invoke } from "@tauri-apps/api/core";

export interface HealthResponse {
  status: string;
  device: "cuda" | "mps" | "cpu";
  gpu_name: string | null;
  vram_mb: number | null;
  ffmpeg_ok: boolean;
}

export interface ModelPreset {
  id: "roformer_2stem" | "htdemucs_4stem" | "htdemucs_6stem";
  label: string;
  stems_count: number;
  size_mb: number;
  is_downloaded: boolean;
}

export interface ProbeResponse {
  source_name: string;
  duration_sec: number;
  sample_rate: number;
  channels: number;
}

export interface StemTrack {
  id: string;
  label: string;
  color: string;
  path: string;
}

export interface JobManifest {
  id: string;
  created_at: string;
  source_name: string;
  duration_sec: number;
  sample_rate: number;
  preset: string;
  status: string;
  original_path: string;
  stems: StemTrack[];
}

export type SeparationStage =
  | "queued"
  | "probing"
  | "loading_model"
  | "separating"
  | "finalizing"
  | "completed"
  | "failed"
  | "cancelled";

export interface SeparationEvent {
  stage: SeparationStage;
  percent: number;
  message: string;
  job_id?: string;
}

export type ExportFormat = "mp3" | "wav" | "flac";
export type ExportMode = "custom_mix" | "single_stem" | "all_stems_folder" | "all_stems_zip";

export interface ExportStemInput {
  id: string;
  volume: number;
  muted: boolean;
  soloed?: boolean;
}

export interface ExportRequestPayload {
  job_id: string;
  target_path: string;
  format: ExportFormat;
  stems: ExportStemInput[];
  mode: ExportMode;
}

export interface ExportResponse {
  saved_path: string;
  bytes: number;
}

const FALLBACK_SIDECAR_URL = "http://127.0.0.1:18420";
const TERMINAL_STAGES: ReadonlySet<SeparationStage> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

async function extractErrorDetail(response: Response, fallback: string): Promise<string> {
  try {
    const payload = (await response.json()) as { detail?: string };
    if (payload.detail) {
      return payload.detail;
    }
  } catch {
    // Non-JSON error body; fall back to HTTP status string.
  }
  return `${fallback} (HTTP ${response.status})`;
}

export async function getSidecarUrl(): Promise<string> {
  try {
    return await invoke<string>("get_sidecar_url");
  } catch {
    return FALLBACK_SIDECAR_URL;
  }
}

export async function getHealth(baseUrl?: string): Promise<HealthResponse> {
  const url = baseUrl ?? (await getSidecarUrl());
  const response = await fetch(`${url}/health`);
  if (!response.ok) {
    throw new Error(await extractErrorDetail(response, "Sidecar /health failed"));
  }
  return response.json() as Promise<HealthResponse>;
}

export async function getModels(baseUrl?: string): Promise<ModelPreset[]> {
  const url = baseUrl ?? (await getSidecarUrl());
  const response = await fetch(`${url}/models`);
  if (!response.ok) {
    throw new Error(await extractErrorDetail(response, "Sidecar /models failed"));
  }
  return response.json() as Promise<ModelPreset[]>;
}

export async function probeFile(filePath: string, baseUrl?: string): Promise<ProbeResponse> {
  const url = baseUrl ?? (await getSidecarUrl());
  const response = await fetch(`${url}/probe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_path: filePath }),
  });
  if (!response.ok) {
    throw new Error(await extractErrorDetail(response, "Failed to inspect audio file"));
  }
  return response.json() as Promise<ProbeResponse>;
}

export async function startSeparation(
  filePath: string,
  presetId: string,
  baseUrl?: string
): Promise<{ job_id: string }> {
  const url = baseUrl ?? (await getSidecarUrl());
  const response = await fetch(`${url}/separate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_path: filePath, preset_id: presetId }),
  });
  if (!response.ok) {
    throw new Error(await extractErrorDetail(response, "Failed to start separation"));
  }
  return response.json() as Promise<{ job_id: string }>;
}

export async function cancelSeparation(jobId: string, baseUrl?: string): Promise<void> {
  const url = baseUrl ?? (await getSidecarUrl());
  const response = await fetch(`${url}/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(await extractErrorDetail(response, "Failed to cancel separation"));
  }
}

export async function getJobManifest(jobId: string, baseUrl?: string): Promise<JobManifest> {
  const url = baseUrl ?? (await getSidecarUrl());
  const response = await fetch(`${url}/jobs/${encodeURIComponent(jobId)}`);
  if (!response.ok) {
    throw new Error(await extractErrorDetail(response, "Failed to fetch job manifest"));
  }
  return response.json() as Promise<JobManifest>;
}

export function subscribeToJobEvents(
  jobId: string,
  baseUrl: string,
  onEvent: (event: SeparationEvent) => void,
  onStreamError: (message: string) => void
): () => void {
  const source = new EventSource(`${baseUrl}/jobs/${encodeURIComponent(jobId)}/events`);
  let closed = false;

  source.onmessage = (msg) => {
    try {
      const parsed = JSON.parse(msg.data) as SeparationEvent;
      onEvent(parsed);
      if (TERMINAL_STAGES.has(parsed.stage)) {
        closed = true;
        source.close();
      }
    } catch {
      // Ignore malformed keepalive chunks.
    }
  };

  source.onerror = () => {
    if (closed) {
      return;
    }
    closed = true;
    source.close();
    onStreamError("Lost progress stream connection to Python sidecar.");
  };

  return () => {
    closed = true;
    source.close();
  };
}

export async function openJobFolder(pathInJobDir: string): Promise<void> {
  await invoke("open_folder", { path: pathInJobDir });
}

export async function exportMix(
  payload: ExportRequestPayload,
  baseUrl?: string
): Promise<ExportResponse> {
  const url = baseUrl ?? (await getSidecarUrl());
  const response = await fetch(`${url}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(await extractErrorDetail(response, "Export failed"));
  }
  return response.json() as Promise<ExportResponse>;
}
