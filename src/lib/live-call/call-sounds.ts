// The hang-up boop, synthesized so it needs no asset file.
const BOOP_SEC = 0.2;
const BOOP_LEVEL = 0.09;
const SILENT = 0.0001;

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
