// One AudioContext per call: worklet capture out, 24 kHz voice in, dropped at once on barge-in.
import { CAPTURE_WORKLET } from "./capture-worklet";

const VOICE_RATE = 24_000;

export class CallAudio {
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private nextAt = 0;
  private startedAt = 0;
  private queuedSec = 0;
  onIdle: () => void = () => {};
  onStart: () => void = () => {};

  // The context comes from the call tap, the only moment a phone lets it play.
  constructor(readonly ctx: AudioContext) {}

  async capture(onFrame: (pcm: ArrayBuffer) => void) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: "text/javascript" }));
    try {
      await this.ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    this.node = new AudioWorkletNode(this.ctx, "capture-16k");
    this.node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => onFrame(event.data);
    this.ctx.createMediaStreamSource(this.stream).connect(this.node);
    await this.ctx.resume();
  }

  get playing(): boolean {
    return this.sources.size > 0;
  }

  /** Share of the queued voice audio already heard, 0-1. */
  heardShare(): number {
    if (!this.sources.size || !this.queuedSec) return 1;
    return Math.max(0, Math.min(1, (this.ctx.currentTime - this.startedAt) / this.queuedSec));
  }

  play(pcm: Int16Array) {
    if (!pcm.length) return;
    const buffer = this.ctx.createBuffer(1, pcm.length, VOICE_RATE);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) data[i] = pcm[i]! / 32768;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);
    const first = !this.sources.size;
    if (first) {
      this.nextAt = this.ctx.currentTime + 0.05;
      this.startedAt = this.nextAt;
      this.queuedSec = 0;
    }
    source.start(this.nextAt);
    this.nextAt += buffer.duration;
    this.queuedSec += buffer.duration;
    this.sources.add(source);
    source.onended = () => {
      if (!this.sources.delete(source) || this.sources.size) return;
      this.onIdle();
    };
    if (first) this.onStart();
  }

  flush() {
    const had = this.sources.size > 0;
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // never started
      }
    }
    this.sources.clear();
    if (had) this.onIdle();
  }

  close() {
    this.flush();
    this.node?.disconnect();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    void this.ctx.close().catch(() => {});
  }
}
