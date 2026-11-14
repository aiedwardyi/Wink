// A quick call: words said while it connects are kept, and words nothing dealt with go to the bot on hang-up.

// 16 kHz PCM16: the 15 s a socket gets to set up.
const EARLY_MAX_BYTES = 15 * 16_000 * 2;

/** Mic audio from the tap until the voice is ready, sent the moment it is. */
export class EarlyMic {
  readonly frames: ArrayBuffer[] = [];
  spoke = false;
  private bytes = 0;

  add(pcm: ArrayBuffer, loud: boolean) {
    this.spoke ||= loud;
    this.frames.push(pcm);
    this.bytes += pcm.byteLength;
    while (this.bytes > EARLY_MAX_BYTES) this.bytes -= this.frames.shift()!.byteLength;
  }
}

/** His lines that no reply or send has dealt with yet, by line number. */
export class OpenLines {
  private lines: Array<{ n: number; text: string }> = [];

  add(n: number, text: string) {
    this.lines.push({ n, text });
  }

  /** Lines up to `n` were answered or reached the bot. */
  settle(n: number) {
    this.lines = this.lines.filter((line) => line.n > n);
  }

  text(): string {
    return this.lines.map((line) => line.text).join(" ");
  }
}
