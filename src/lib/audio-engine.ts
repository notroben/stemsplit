import { convertFileSrc } from "@tauri-apps/api/core";
import type { JobManifest } from "./sidecar";

export interface StemChannelState {
  volume: number;
  muted: boolean;
  soloed: boolean;
}

interface StemChannel extends StemChannelState {
  id: string;
  buffer: AudioBuffer;
  gainNode: GainNode;
  source: AudioBufferSourceNode | null;
  peaks: Float32Array;
}

const DEFAULT_PEAK_BUCKETS = 1200;
const LONG_TRACK_DURATION_SEC = 600;
const PLAY_START_LEAD_SEC = 0.02;
const GAIN_RAMP_TAU_SEC = 0.01;

/**
 * Compute normalized min/max waveform peak pairs once per AudioBuffer.
 * Returns a Float32Array of length bucketCount * 2 containing [min, max] pairs.
 */
export function computeWaveformPeaks(
  buffer: AudioBuffer,
  bucketCount = DEFAULT_PEAK_BUCKETS
): Float32Array {
  const peaks = new Float32Array(bucketCount * 2);
  const channelData = buffer.getChannelData(0);
  const totalSamples = channelData.length;
  if (totalSamples === 0 || bucketCount <= 0) {
    return peaks;
  }

  // Subsample inside each bucket for tracks > 10 minutes so peak scan stays instantaneous.
  const isLongTrack = buffer.duration > LONG_TRACK_DURATION_SEC;

  for (let i = 0; i < bucketCount; i += 1) {
    const start = Math.floor((i * totalSamples) / bucketCount);
    const end = Math.max(start + 1, Math.floor(((i + 1) * totalSamples) / bucketCount));
    const bucketSize = end - start;
    const stride = isLongTrack ? Math.max(1, Math.floor(bucketSize / 64)) : 1;

    let minVal = 1.0;
    let maxVal = -1.0;
    for (let j = start; j < end; j += stride) {
      const sample = channelData[j];
      if (sample < minVal) minVal = sample;
      if (sample > maxVal) maxVal = sample;
    }

    peaks[i * 2] = minVal;
    peaks[i * 2 + 1] = maxVal;
  }

  return peaks;
}

/**
 * Sample-accurate multi-stem playback engine backed by one shared AudioContext clock.
 */
export class MultiStemAudioEngine {
  private ctx: AudioContext | null = null;
  private masterGainNode: GainNode | null = null;
  private originalGainNode: GainNode | null = null;
  private originalBuffer: AudioBuffer | null = null;
  private originalSource: AudioBufferSourceNode | null = null;
  private channels = new Map<string, StemChannel>();

  private playing = false;
  private loop = false;
  private abOriginal = false;
  private masterVolume = 1.0;
  private duration = 0;
  private startContextTime = 0;
  private startOffset = 0;
  private pauseOffset = 0;
  private disposed = false;
  private playbackSessionId = 0;
  private endedListener: (() => void) | null = null;

  async loadJob(manifest: JobManifest): Promise<Map<string, Float32Array>> {
    this.dispose();
    this.disposed = false;

    const ctx = new AudioContext();
    this.ctx = ctx;

    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(this.masterVolume, ctx.currentTime);
    masterGain.connect(ctx.destination);
    this.masterGainNode = masterGain;

    const originalGain = ctx.createGain();
    originalGain.gain.setValueAtTime(0, ctx.currentTime);
    originalGain.connect(masterGain);
    this.originalGainNode = originalGain;

    const paths = [manifest.original_path, ...manifest.stems.map((stem) => stem.path)];
    const buffers = await Promise.all(
      paths.map(async (filePath) => {
        const assetUrl = convertFileSrc(filePath);
        const response = await fetch(assetUrl);
        if (!response.ok) {
          throw new Error(`Failed to load audio buffer from ${filePath} (HTTP ${response.status})`);
        }
        const arrayBuffer = await response.arrayBuffer();
        return ctx.decodeAudioData(arrayBuffer);
      })
    );

    if (this.disposed) {
      void ctx.close().catch(() => {});
      return new Map();
    }

    this.originalBuffer = buffers[0];
    let maxDuration = buffers[0].duration;
    const peaksMap = new Map<string, Float32Array>();

    manifest.stems.forEach((stem, idx) => {
      const buffer = buffers[idx + 1];
      if (buffer.duration > maxDuration) {
        maxDuration = buffer.duration;
      }

      const gainNode = ctx.createGain();
      gainNode.gain.setValueAtTime(1.0, ctx.currentTime);
      gainNode.connect(masterGain);

      const peaks = computeWaveformPeaks(buffer, DEFAULT_PEAK_BUCKETS);
      peaksMap.set(stem.id, peaks);

      this.channels.set(stem.id, {
        id: stem.id,
        buffer,
        gainNode,
        source: null,
        peaks,
        volume: 1.0,
        muted: false,
        soloed: false,
      });
    });

    this.duration = maxDuration;
    this.pauseOffset = 0;
    this.startOffset = 0;
    this.applyEffectiveGains(true);

    return peaksMap;
  }

  onEnded(listener: () => void): void {
    this.endedListener = listener;
  }

  getDuration(): number {
    return this.duration;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  getCurrentTime(): number {
    if (!this.playing || !this.ctx) {
      return this.pauseOffset;
    }
    const elapsed = Math.max(0, this.ctx.currentTime - this.startContextTime);
    return Math.min(this.duration, this.startOffset + elapsed);
  }

  play(): void {
    if (this.disposed || !this.ctx || !this.originalBuffer || this.channels.size === 0 || this.playing) {
      return;
    }

    if (this.ctx.state === "suspended") {
      void this.ctx.resume();
    }

    const offset =
      this.pauseOffset >= this.duration - 0.01
        ? 0
        : Math.max(0, Math.min(this.pauseOffset, this.duration));
    const startAt = this.ctx.currentTime + PLAY_START_LEAD_SEC;

    this.playbackSessionId += 1;
    const session = this.playbackSessionId;

    const origSource = this.ctx.createBufferSource();
    origSource.buffer = this.originalBuffer;
    origSource.connect(this.originalGainNode!);
    this.originalSource = origSource;

    const stemSources: AudioBufferSourceNode[] = [];
    for (const channel of this.channels.values()) {
      const source = this.ctx.createBufferSource();
      source.buffer = channel.buffer;
      source.connect(channel.gainNode);
      channel.source = source;
      stemSources.push(source);
    }

    origSource.onended = () => {
      if (this.disposed || session !== this.playbackSessionId || !this.playing) {
        return;
      }
      if (this.loop) {
        this.seek(0);
        return;
      }
      this.stopActiveSources();
      this.playing = false;
      this.pauseOffset = 0;
      this.endedListener?.();
    };

    // Start original and all stem buffers at the exact same hardware timestamp.
    origSource.start(startAt, offset);
    for (const source of stemSources) {
      source.start(startAt, offset);
    }

    this.startContextTime = startAt;
    this.startOffset = offset;
    this.playing = true;
    this.applyEffectiveGains(true);
  }

  pause(): void {
    if (!this.playing || !this.ctx) {
      return;
    }
    const current = this.getCurrentTime();
    this.stopActiveSources();
    this.playing = false;
    this.pauseOffset = current;
  }

  seek(offsetSec: number): void {
    if (this.disposed || !this.ctx) {
      return;
    }
    const clamped = Math.max(0, Math.min(offsetSec, this.duration));
    const wasPlaying = this.playing;
    this.stopActiveSources();
    this.playing = false;
    this.pauseOffset = clamped;
    if (wasPlaying) {
      this.play();
    }
  }

  setLoop(enabled: boolean): void {
    this.loop = enabled;
  }

  setAbOriginal(enabled: boolean): void {
    this.abOriginal = enabled;
    this.applyEffectiveGains(false);
  }

  setMasterVolume(volume: number): void {
    this.masterVolume = Math.max(0, Math.min(1.5, volume));
    this.applyEffectiveGains(false);
  }

  setStemState(stemId: string, patch: Partial<StemChannelState>): void {
    const channel = this.channels.get(stemId);
    if (!channel) {
      return;
    }
    if (patch.volume !== undefined) {
      channel.volume = Math.max(0, Math.min(1.5, patch.volume));
    }
    if (patch.muted !== undefined) {
      channel.muted = patch.muted;
    }
    if (patch.soloed !== undefined) {
      channel.soloed = patch.soloed;
    }
    this.applyEffectiveGains(false);
  }

  private applyEffectiveGains(immediate: boolean): void {
    if (!this.ctx || !this.masterGainNode || !this.originalGainNode) {
      return;
    }
    const now = this.ctx.currentTime;

    const setGain = (node: GainNode, target: number) => {
      if (immediate) {
        node.gain.cancelScheduledValues(now);
        node.gain.setValueAtTime(target, now);
      } else {
        node.gain.setTargetAtTime(target, now, GAIN_RAMP_TAU_SEC);
      }
    };

    setGain(this.masterGainNode, this.masterVolume);

    if (this.abOriginal) {
      setGain(this.originalGainNode, 1.0);
      for (const channel of this.channels.values()) {
        setGain(channel.gainNode, 0);
      }
      return;
    }

    setGain(this.originalGainNode, 0);
    const anySoloed = Array.from(this.channels.values()).some((c) => c.soloed);
    for (const channel of this.channels.values()) {
      const audible = !channel.muted && (!anySoloed || channel.soloed);
      setGain(channel.gainNode, audible ? channel.volume : 0);
    }
  }

  private stopActiveSources(): void {
    this.playbackSessionId += 1;
    if (this.originalSource) {
      this.originalSource.onended = null;
      try {
        this.originalSource.stop();
      } catch {
        // Ignore if source already finished.
      }
      this.originalSource.disconnect();
      this.originalSource = null;
    }

    for (const channel of this.channels.values()) {
      if (channel.source) {
        try {
          channel.source.stop();
        } catch {
          // Ignore if source already finished.
        }
        channel.source.disconnect();
        channel.source = null;
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.playing = false;
    this.stopActiveSources();

    for (const channel of this.channels.values()) {
      channel.gainNode.disconnect();
    }
    this.channels.clear();

    this.originalGainNode?.disconnect();
    this.originalGainNode = null;

    this.masterGainNode?.disconnect();
    this.masterGainNode = null;

    this.originalBuffer = null;

    if (this.ctx) {
      void this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}
