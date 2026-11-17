// One AudioContext per call: worklet capture out, 24 kHz voice in, dropped at once on barge-in.
import { boop } from "./call-sounds";
import { CAPTURE_WORKLET } from "./capture-worklet";
import { OUTPUT_GAIN } from "../../../shared/live-call";
import { Stretch } from "./stretch";
import type { CallSound } from "./warm-audio";

const VOICE_RATE = 24_000;
const FADE_SAMPLES = 0.3 * VOICE_RATE;
const PIECE = VOICE_RATE / 5;
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
  // Where each queued buffer starts, on the clock and in the turn, so a new speed remakes only what is not yet heard.
  // The stretch holds one turn; a remake touches only that turn's audio, never an earlier turn still queued.
  private queued = new Map<AudioBufferSourceNode, { at: number; from: number; turn: number }>();
  private turn = 0;
  private readonly stretch = new Stretch();
  private nextAt = 0;
  private startedAt = 0;
  private queuedSec = 0;
  private readonly voice: AnalyserNode;
  private readonly out: GainNode;
  private readonly destination: MediaStreamAudioDestinationNode;
  readonly ctx: AudioContext;
  private readonly output: HTMLAudioElement;
  private mic: AnalyserNode | null = null;
  private tailMs = 0;
  private faded = 0;
  private readonly samples = new Float32Array(256);
  onIdle: () => void = () => {};
  onStart: () => void = () => {};

  constructor({ ctx, voice }: CallSound) {
    this.ctx = ctx;
    this.output = voice;
    this.voice = ctx.createAnalyser();
    this.voice.fftSize = this.samples.length;
    this.destination = ctx.createMediaStreamDestination();
    this.out = ctx.createGain();
    this.out.gain.value = OUTPUT_GAIN;
    this.voice.connect(this.out);
    this.out.connect(this.destination);
  }

  /** False once the mic is open but the voice waits on a tap: a call answered from a notification, or a slow mic prompt, has no tap left. */
  async capture(onFrame: (pcm: ArrayBuffer) => void): Promise<boolean> {
    const stream = await navigator.mediaDevices.getUserMedia(MIC);
    // A keyless try's mic, granted late, must not stay on beside this one.
    if (this.stream !== stream) for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = stream;
    // The mic now opens beside the call token, so a hang-up or a failed token can land first.
    if (this.closed) {
      this.stopMic();
      return false;
    }
    if (!this.node) {
      const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: "text/javascript" }));
      try {
        await this.ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      this.node = new AudioWorkletNode(this.ctx, "capture-16k");
      this.mic = this.ctx.createAnalyser();
      this.mic.fftSize = this.samples.length;
    }
    this.node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => onFrame(event.data);
    this.listen(this.stream);
    const [running, played] = await Promise.all([this.tapped(this.ctx.resume()), this.tapped(this.speak(this.stream))]);
    return running && played;
  }

  // Takes the open mic as proof: Android gives a stream call or media volume once, as it opens, by whether a mic is open then; the side keys follow the mic.
  private speak(_mic: MediaStream) {
    if (this.output.srcObject !== this.destination.stream) this.output.srcObject = this.destination.stream;
    return this.output.play();
  }

  /** False while the phone wants a tap, which can leave `start` pending. */
  private tapped(start: Promise<unknown>): Promise<boolean> {
    return Promise.race([start.then(() => true, () => false), new Promise<boolean>((resolve) => setTimeout(resolve, HEAL_MS, false))]);
  }

  private listen(stream: MediaStream) {
    this.source?.disconnect();
    this.stream = stream;
    this.source = this.ctx.createMediaStreamSource(stream);
    this.source.connect(this.node!);
    this.source.connect(this.mic!);
  }

  /** Mic off with the context kept, so a later capture() opens it again. */
  stopMic() {
    this.source?.disconnect();
    this.source = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
  }

  /** Back from the background: true once the mic and the voice run again, false while the phone wants a tap. */
  async heal(): Promise<boolean> {
    if (!this.node || this.closed) return false;
    // With the mic open, both start before any await, so a tap's permission to play reaches them.
    const resumed = this.tapped(this.ctx.resume());
    const track = this.stream?.getAudioTracks()[0];
    if (!track || track.readyState === "ended" || track.muted) this.reopening ??= this.reopen();
    const voice = () => (this.output.paused && this.stream ? this.tapped(this.speak(this.stream)) : true);
    const spoken = this.reopening ? this.reopening.then((mic) => mic && voice()) : voice();
    const [running, played] = await Promise.all([resumed, spoken]);
    return running && played && this.ctx.state === "running" && !this.closed;
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
    this.tailMs = boop(this.ctx, this.out);
  }

  /** Loudness 0-1 of the voice, or of whoever is louder when `mic` is on; read per frame. */
  level(mic: boolean): number {
    const voice = this.rms(this.voice);
    return Math.min(1, 4 * (mic && this.mic ? Math.max(voice, this.rms(this.mic)) : voice));
  }

  /** Raw loudness of the mic alone; 0 before capture. */
  micLevel(): number {
    return this.mic ? this.rms(this.mic) : 0;
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
    if (this.stretch.ended) {
      this.stretch.reset();
      this.turn += 1;
    }
    const raw = new Float32Array(pcm.length);
    // Only the call's first words ease in; every later reply starts at full level.
    for (let i = 0; i < pcm.length; i++) raw[i] = (pcm[i]! / 32768) * (this.faded < FADE_SAMPLES ? this.faded++ / FADE_SAMPLES : 1);
    const from = this.stretch.done;
    this.schedule(this.stretch.push(raw), from);
  }

  /** The turn's audio is all in: what the stretch held back plays too. */
  endTurn() {
    const from = this.stretch.done;
    this.schedule(this.stretch.end(), from);
  }

  /** Speed and level for the next words heard: the level moves at once, and queued words are remade at the new speed. */
  tune(speed: number, level: number) {
    this.out.gain.setTargetAtTime(OUTPUT_GAIN * level, this.ctx.currentTime, 0.03);
    if (speed === this.stretch.speed) return;
    const now = this.ctx.currentTime;
    let first: { at: number; from: number } | undefined;
    for (const [source, spot] of this.queued) {
      if (spot.at <= now || spot.turn !== this.turn) continue;
      if (!first || spot.at < first.at) first = spot;
      source.onended = null;
      source.stop();
      this.sources.delete(source);
      this.queued.delete(source);
      this.queuedSec -= source.buffer?.duration ?? 0;
    }
    if (first) this.nextAt = first.at;
    const from = first?.from ?? this.stretch.done;
    // In pieces, so a later change finds most of it still unstarted.
    const data = this.stretch.restart(from, speed);
    for (let at = 0; at < data.length; at += PIECE) this.schedule(data.subarray(at, at + PIECE), from + Math.round(at * speed));
    if (first && !this.sources.size) this.onIdle();
  }

  private schedule(data: Float32Array, from: number) {
    if (!data.length) return;
    const buffer = this.ctx.createBuffer(1, data.length, VOICE_RATE);
    buffer.getChannelData(0).set(data);
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
    this.queued.set(source, { at: this.nextAt, from, turn: this.turn });
    this.nextAt += buffer.duration;
    this.queuedSec += buffer.duration;
    this.sources.add(source);
    source.onended = () => {
      this.queued.delete(source);
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
    this.queued.clear();
    this.stretch.reset();
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
