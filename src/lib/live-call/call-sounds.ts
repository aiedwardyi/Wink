// The ring and the hang-up boop, synthesized so they need no asset file.
const RING_SEC = 1;
const RING_LEVEL = 0.05;
const BOOP_SEC = 0.2;
const BOOP_LEVEL = 0.09;
const SILENT = 0.0001;

/** One soft two-tone ring into `out`; the returned function cuts it short. */
export function ring(ctx: AudioContext, out: AudioNode): () => void {
  const start = ctx.currentTime;
  const envelope = ctx.createGain();
  envelope.gain.setValueAtTime(SILENT, start);
  envelope.gain.linearRampToValueAtTime(RING_LEVEL, start + 0.1);
  envelope.gain.setValueAtTime(RING_LEVEL, start + RING_SEC - 0.3);
  envelope.gain.linearRampToValueAtTime(SILENT, start + RING_SEC);
  const cut = ctx.createGain();
  const warm = ctx.createBiquadFilter();
  warm.type = "lowpass";
  warm.frequency.value = 1_200;
  envelope.connect(warm);
  warm.connect(cut);
  cut.connect(out);
  const tones = [440, 480].map((hz) => {
    const tone = ctx.createOscillator();
    tone.type = "sine";
    tone.frequency.value = hz;
    tone.connect(envelope);
    tone.start(start);
    tone.stop(start + RING_SEC);
    return tone;
  });
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    const now = ctx.currentTime;
    // A fade, not a hard stop: cutting a live sine at full level clicks.
    cut.gain.setTargetAtTime(0, now, 0.01);
    for (const tone of tones) tone.stop(now + 0.08);
  };
}

/** One short, low, falling boop into `out`. Returns how long it needs the output, in ms. */
export function boop(ctx: AudioContext, out: AudioNode): number {
  const start = ctx.currentTime;
  const tone = ctx.createOscillator();
  tone.type = "sine";
  tone.frequency.setValueAtTime(240, start);
  tone.frequency.exponentialRampToValueAtTime(170, start + BOOP_SEC);
  const envelope = ctx.createGain();
  envelope.gain.setValueAtTime(SILENT, start);
  envelope.gain.linearRampToValueAtTime(BOOP_LEVEL, start + 0.015);
  envelope.gain.exponentialRampToValueAtTime(SILENT, start + BOOP_SEC);
  tone.connect(envelope);
  envelope.connect(out);
  tone.start(start);
  tone.stop(start + BOOP_SEC);
  return BOOP_SEC * 1_000 + 50;
}
