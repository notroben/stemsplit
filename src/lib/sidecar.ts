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

const FALLBACK_SIDECAR_URL = "http://127.0.0.1:18420";

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
    throw new Error(`Sidecar /health failed with HTTP ${response.status}`);
  }
  return response.json() as Promise<HealthResponse>;
}

export async function getModels(baseUrl?: string): Promise<ModelPreset[]> {
  const url = baseUrl ?? (await getSidecarUrl());
  const response = await fetch(`${url}/models`);
  if (!response.ok) {
    throw new Error(`Sidecar /models failed with HTTP ${response.status}`);
  }
  return response.json() as Promise<ModelPreset[]>;
}
