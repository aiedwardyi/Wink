// One AudioContext per call: worklet capture out, 24 kHz voice in, dropped at once on barge-in.
import { boop } from "./call-sounds";
import { CAPTURE_WORKLET } from "./capture-worklet";

const VOICE_RATE = 24_000;
const FADE_SAMPLES = 0.3 * VOICE_RATE;
const MIC = { audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } };
// A phone that wants a tap leaves resume() pending, so the check gives up after this.
const HEAL_MS = 800;

export class CallAudio {
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private reopening?: Promise<boolean>;
  private closed = false;
  private sources = new Set<AudioBufferSourceNode>();
  private nextAt = 0;
  private startedAt = 0;
  private queuedSec = 0;
  private readonly voice: AnalyserNode;
  private readonly destination: MediaStreamAudioDestinationNode;
  private readonly output = new Audio();
  private mic: AnalyserNode | null = null;
  private tailMs = 0;
  private faded = 0;
  private readonly samples = new Float32Array(256);
  onIdle: () => void = () => {};
  onStart: () => void = () => {};

  // The context comes from the call tap, the only moment a phone lets it play.
  constructor(readonly ctx: AudioContext) {
    this.voice = ctx.createAnalyser();
    this.voice.fftSize = this.samples.length;
    this.destination = ctx.createMediaStreamDestination();
    this.voice.connect(this.destination);
  }

  async capture(onFrame: (pcm: ArrayBuffer) => void) {
    this.stream = await navigator.mediaDevices.getUserMedia(MIC);
    const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: "text/javascript" }));
    try {
      await this.ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    this.node = new AudioWorkletNode(this.ctx, "capture-16k");
    this.node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => onFrame(event.data);
    this.mic = this.ctx.createAnalyser();
    this.mic.fftSize = this.samples.length;
    this.listen(this.stream);
    await this.ctx.resume();
    // Open the speaker stream after capture selects Android's call audio mode.
    this.output.srcObject = this.destination.stream;
    await this.output.play();
  }

  private listen(stream: MediaStream) {
    this.source?.disconnect();
    this.stream = stream;
    this.source = this.ctx.createMediaStreamSource(stream);
    this.source.connect(this.node!);
    this.source.connect(this.mic!);
  }

  /** Back from the background: true once the mic and the voice run again, false while the phone wants a tap. */
  async heal(): Promise<boolean> {
    if (!this.node || this.closed) return false;
    // Both start before any await, so a tap's permission to play reaches them.
    const out = Promise.all([this.ctx.resume(), this.output.paused ? this.output.play() : undefined]).then(() => true, () => false);
    const track = this.stream?.getAudioTracks()[0];
    if (!track || track.readyState === "ended" || track.muted) this.reopening ??= this.reopen();
    const [mic, played] = await Promise.all([this.reopening ?? true, Promise.race([out, new Promise<boolean>((resolve) => setTimeout(resolve, HEAL_MS, false))])]);
    return mic && played && this.ctx.state === "running" && !this.closed;
  }

  private async reopen(): Promise<boolean> {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    try {
      const stream = await navigator.mediaDevices.getUserMedia(MIC);
      // A hang-up while the phone granted it must not leave the mic on.
      if (this.closed) {
        for (const track of stream.getTracks()) track.stop();
        return false;
      }
      this.listen(stream);
      return true;
    } catch {
      return false;
    } finally {
      this.reopening = undefined;
    }
  }

  /** Call before close(): the output stays open just long enough to finish it. */
  boop() {
    this.tailMs = boop(this.ctx, this.destination);
  }

  /** Loudness 0-1 of the voice, or of whoever is louder when `mic` is on; read per frame. */
  level(mic: boolean): number {
    const voice = this.rms(this.voice);
    return Math.min(1, 4 * (mic && this.mic ? Math.max(voice, this.rms(this.mic)) : voice));
  }

  private rms(node: AnalyserNode): number {
    node.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const sample of this.samples) sum += sample * sample;
    return Math.sqrt(sum / this.samples.length);
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
    // Only the call's first words ease in; every later reply starts at full level.
    for (let i = 0; i < pcm.length; i++) data[i] = (pcm[i]! / 32768) * (this.faded < FADE_SAMPLES ? this.faded++ / FADE_SAMPLES : 1);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.voice);
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
    this.closed = true;
    this.flush();
    this.node?.disconnect();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    const release = () => {
      this.output.pause();
      this.output.srcObject = null;
      for (const track of this.destination.stream.getTracks()) track.stop();
      void this.ctx.close().catch(() => {});
    };
    if (this.tailMs) setTimeout(release, this.tailMs);
    else release();
  }
}
