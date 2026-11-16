// Speech sped up or slowed with its pitch kept (WSOLA): 30 ms frames laid 15 ms apart, each taken where it best continues the last.
const WINDOW = 720;
const HOP = WINDOW / 2;
const SEEK = 192;
const FADE = Float32Array.from({ length: WINDOW }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WINDOW));

/** One turn of 24 kHz voice; speed 1 passes it through untouched. */
export class Stretch {
  private input = new Float32Array(1 << 16);
  private length = 0;
  private start = 0;
  private prev = -1;
  private pos = 0;
  private readonly tail = new Float32Array(HOP);
  ended = false;

  constructor(public speed = 1) {}

  /** Where in the turn the audio made so far ends; the next output picks up here. */
  get done(): number {
    return this.prev < 0 ? this.start : this.prev + HOP;
  }

  push(chunk: Float32Array): Float32Array {
    if (this.length + chunk.length > this.input.length) {
      const grown = new Float32Array(Math.max(this.input.length * 2, this.length + chunk.length));
      grown.set(this.input.subarray(0, this.length));
      this.input = grown;
    }
    this.input.set(chunk, this.length);
    this.length += chunk.length;
    return this.run();
  }

  /** The rest of the turn, held back while a frame waited for more audio. */
  end(): Float32Array {
    this.ended = true;
    return this.run();
  }

  /** Makes the turn again from `at` at a new speed: audio already played stays as it was. */
  restart(at: number, speed: number): Float32Array {
    this.speed = speed;
    this.start = Math.min(at, this.length);
    this.prev = -1;
    return this.run();
  }

  reset() {
    this.length = this.start = 0;
    this.prev = -1;
    this.ended = false;
  }

  private run(): Float32Array {
    const out: number[] = [];
    const input = this.input;
    if (this.speed === 1) {
      const from = this.done;
      this.start = this.length;
      this.prev = -1;
      return input.slice(from, this.length);
    }
    for (;;) {
      if (this.prev < 0) {
        if (this.start + WINDOW > this.length) break;
        for (let i = 0; i < HOP; i++) out.push(input[this.start + i]!);
        for (let i = 0; i < HOP; i++) this.tail[i] = input[this.start + HOP + i]! * FADE[HOP + i]!;
        this.prev = this.start;
        this.pos = this.start + HOP * this.speed;
        continue;
      }
      const target = Math.round(this.pos);
      const hi = target + SEEK;
      if (hi + WINDOW > this.length) break;
      const natural = this.prev + HOP;
      let best = Math.max(0, target - SEEK);
      let score = -Infinity;
      for (let at = best; at <= hi; at++) {
        let sum = 0;
        for (let i = 0; i < HOP; i += 2) sum += input[at + i]! * input[natural + i]!;
        if (sum > score) {
          score = sum;
          best = at;
        }
      }
      for (let i = 0; i < HOP; i++) out.push(this.tail[i]! + input[best + i]! * FADE[i]!);
      for (let i = 0; i < HOP; i++) this.tail[i] = input[best + HOP + i]! * FADE[HOP + i]!;
      this.prev = best;
      this.pos += HOP * this.speed;
    }
    if (this.ended) {
      const from = this.done;
      for (let i = from; i < this.length; i++) out.push(input[i]!);
      this.start = this.length;
      this.prev = -1;
    }
    return Float32Array.from(out);
  }
}
