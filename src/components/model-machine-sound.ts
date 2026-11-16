export type ClunkWeight = "light" | "medium" | "heavy";

const WEIGHTS = {
  light: { body: 150, drop: 82, decay: 0.12, ring: [2310, 3470, 5120], gain: 0.9 },
  medium: { body: 112, drop: 58, decay: 0.17, ring: [1870, 2950, 4310], gain: 1 },
  heavy: { body: 86, drop: 44, decay: 0.24, ring: [1420, 2260, 3390], gain: 1.1 },
} satisfies Record<ClunkWeight, { body: number; drop: number; decay: number; ring: number[]; gain: number }>;
// Calibrated by rendering: peak lands near -18 dBFS.
const MASTER = 0.15;

let noise: { ctx: BaseAudioContext; buffer: AudioBuffer } | null = null;

// Seeded, so every clunk and every render is the same sound.
function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  if (noise?.ctx === ctx) return noise.buffer;
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.4), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let seed = 0x2f6b1d;
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    data[i] = seed / 0x80000000 - 1;
  }
  noise = { ctx, buffer };
  return buffer;
}

function envelope(ctx: BaseAudioContext, at: number, peak: number, attack: number, decay: number, out: AudioNode): GainNode {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  gain.connect(out);
  return gain;
}

function burst(ctx: BaseAudioContext, at: number, length: number, into: AudioNode, offset: number) {
  const source = ctx.createBufferSource();
  source.buffer = noiseBuffer(ctx);
  source.connect(into);
  source.start(at, offset, length);
}

/** A can landing in the tray: low thud, a muffled knock, a short tin ring, then two settling taps. */
export function clunk(ctx: BaseAudioContext, at = ctx.currentTime, weight: ClunkWeight = "medium") {
  const w = WEIGHTS[weight];
  const master = ctx.createGain();
  master.gain.value = MASTER * w.gain;
  master.connect(ctx.destination);

  const body = ctx.createOscillator();
  body.type = "triangle";
  body.frequency.setValueAtTime(w.body, at);
  body.frequency.exponentialRampToValueAtTime(w.drop, at + 0.09);
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = 520;
  body.connect(lowpass);
  lowpass.connect(envelope(ctx, at, 0.9, 0.004, w.decay, master));
  body.start(at);
  body.stop(at + w.decay + 0.05);

  const knock = ctx.createBiquadFilter();
  knock.type = "bandpass";
  knock.frequency.value = 900;
  knock.Q.value = 0.9;
  knock.connect(envelope(ctx, at, 0.55, 0.002, 0.06, master));
  burst(ctx, at, 0.08, knock, 0);

  for (const [k, settle] of [[0, 0], [1, 0.115], [2, 0.21]] as const) {
    const t = at + settle;
    for (const [j, freq] of w.ring.entries()) {
      const ring = ctx.createBiquadFilter();
      ring.type = "bandpass";
      ring.frequency.value = freq * (1 + k * 0.012);
      ring.Q.value = 28;
      ring.connect(envelope(ctx, t, [1.1, 0.5, 0.22][k]! / (j + 1), 0.003, 0.34 - j * 0.07, master));
      burst(ctx, t, 0.03, ring, 0.1 + k * 0.1 + j * 0.03);
    }
  }
  const tap = ctx.createBiquadFilter();
  tap.type = "bandpass";
  tap.frequency.value = 1300;
  tap.Q.value = 1.4;
  tap.connect(envelope(ctx, at + 0.115, 0.22, 0.002, 0.04, master));
  burst(ctx, at + 0.115, 0.04, tap, 0.33);
}
