// AudioWorklet source: mic at the context rate -> 16 kHz PCM16 in 40 ms frames. Loaded from a Blob URL.
export const CAPTURE_WORKLET = `
class Capture16k extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / 16000;
    this.at = 0;
    this.frame = new Int16Array(640);
    this.filled = 0;
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    while (this.at < input.length) {
      const i = Math.floor(this.at);
      const f = this.at - i;
      const s = input[i] * (1 - f) + (i + 1 < input.length ? input[i + 1] : input[i]) * f;
      this.frame[this.filled++] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
      if (this.filled === this.frame.length) {
        this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
        this.frame = new Int16Array(640);
        this.filled = 0;
      }
      this.at += this.step;
    }
    this.at -= input.length;
    return true;
  }
}
registerProcessor("capture-16k", Capture16k);
`;
