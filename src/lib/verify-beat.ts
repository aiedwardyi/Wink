// The first demo's 174 BPM click: pitch-swept kick on beats, highpassed noise hat on 8ths.
export const BEAT_MS = 60_000 / 174;
export const SIXTEENTH_MS = BEAT_MS / 4;
const EIGHTH_MS = BEAT_MS / 2;
const LOOKAHEAD_MS = 150;
const MUTED_KEY = "wink.verifyWatch.muted";

export type BeatHit = { ms: number; kind: "kick" | "hat" };

export function beatHits(fromMs: number, toMs: number): BeatHit[] {
  const out: BeatHit[] = [];
  for (let i = Math.max(0, Math.ceil(fromMs / EIGHTH_MS - 1e-9)); i * EIGHTH_MS < toMs; i++) {
    if (i % 2 === 0) out.push({ ms: i * EIGHTH_MS, kind: "kick" });
    out.push({ ms: i * EIGHTH_MS, kind: "hat" });
  }
  return out;
}

const cache = new Map<string, Float32Array>();

export function hitSamples(kind: BeatHit["kind"], rate: number): Float32Array {
  const key = `${kind}:${rate}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const out = new Float32Array(Math.round(rate * (kind === "kick" ? 0.45 : 0.06)));
  let seed = 0x2545f491, last = 0, high = 0;
  const a = 1 / (1 + 2 * Math.PI * 7000 / rate);
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    if (kind === "kick") out[i] = 0.9 * Math.sin(2 * Math.PI * (45 * t + (110 / 30) * (1 - Math.exp(-30 * t)))) * Math.exp(-10 * t);
    else {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      const noise = (seed >>> 0) / 0xffffffff * 2 - 1;
      high = a * (high + noise - last);
      last = noise;
      out[i] = high * Math.exp(-80 * t) * 0.5;
    }
  }
  cache.set(key, out);
  return out;
}

/** The beat as one track, for proving it without speakers. */
export function renderBeat(rate: number, ms: number): Float32Array {
  const out = new Float32Array(Math.round(rate * ms / 1000));
  for (const hit of beatHits(0, ms)) {
    const samples = hitSamples(hit.kind, rate), at = Math.round(hit.ms * rate / 1000);
    for (let i = 0; i < samples.length && at + i < out.length; i++) out[at + i]! += samples[i]!;
  }
  for (let i = 0; i < out.length; i++) out[i] = Math.max(-0.95, Math.min(0.95, out[i]!));
  return out;
}

export function beatMuted(): boolean {
  try { return localStorage.getItem(MUTED_KEY) === "1"; } catch { return false; }
}

export function setBeatMuted(muted: boolean) {
  try { localStorage.setItem(MUTED_KEY, muted ? "1" : "0"); } catch { /* private mode */ }
}

/** Plays the grid of a show clock; call sync every animation frame while the show plays. */
export function createBeat() {
  let ctx: AudioContext | null = null;
  let gain: GainNode | null = null;
  let until = -1;
  const sources = new Set<AudioBufferSourceNode>();
  const buffers = new Map<string, AudioBuffer>();
  const buffer = (kind: BeatHit["kind"]) => {
    let value = buffers.get(kind);
    if (!value && ctx) {
      const samples = hitSamples(kind, ctx.sampleRate);
      value = ctx.createBuffer(1, samples.length, ctx.sampleRate);
      value.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
      buffers.set(kind, value);
    }
    return value;
  };
  const stop = () => {
    for (const source of sources) { try { source.stop(); } catch { /* not started */ } }
    sources.clear();
    until = -1;
  };
  return {
    sync(showMs: number) {
      if (typeof AudioContext === "undefined") return;
      ctx ??= new AudioContext({ latencyHint: "interactive" });
      if (!gain) { gain = ctx.createGain(); gain.gain.value = 0.35; gain.connect(ctx.destination); }
      if (ctx.state === "suspended") void ctx.resume().catch(() => {});
      if (until < 0) until = showMs;
      const end = showMs + LOOKAHEAD_MS;
      for (const hit of beatHits(until, end)) {
        const node = ctx.createBufferSource();
        const samples = buffer(hit.kind);
        if (!samples) continue;
        node.buffer = samples;
        node.connect(gain);
        node.onended = () => sources.delete(node);
        node.start(ctx.currentTime + Math.max(0, hit.ms - showMs) / 1000);
        sources.add(node);
      }
      until = end;
    },
    stop,
    close() {
      stop();
      void ctx?.close().catch(() => {});
      ctx = null;
      gain = null;
      buffers.clear();
    },
  };
}
