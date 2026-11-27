import { afterEach, describe, expect, it, vi } from "vitest";

import { CallAudio } from "./audio";
import type { CallSound } from "./warm-audio";

// gemini-3.8-live recordings of Aoede, Alnilam and Erinome, played at unity gain.
const RECORDED = { lufs: -17.2, peakDb: -1.3 };

type Port = { connect?: ReturnType<typeof vi.fn>; disconnect?: ReturnType<typeof vi.fn> };
type Node = { connect: ReturnType<typeof vi.fn>; gain?: { value: number } };

function gainTo(node: Node, to: Port): number | undefined {
  for (const [next] of node.connect.mock.calls) {
    if (next === to) return 1;
    const rest = next?.connect ? gainTo(next, to) : undefined;
    if (rest !== undefined) return rest * (next.gain?.value ?? 1);
  }
  return undefined;
}

function setup() {
  const micTrack = { stop: vi.fn(), readyState: "live", muted: false };
  const voiceTrack = { stop: vi.fn() };
  const stream = { getTracks: () => [micTrack], getAudioTracks: () => [micTrack] };
  const destination = { stream: { getTracks: () => [voiceTrack] }, disconnect: vi.fn() };
  const output = { srcObject: null as unknown, paused: true, play: vi.fn(async () => { output.paused = false; }), pause: vi.fn(() => { output.paused = true; }) };
  vi.stubGlobal("Audio", class { constructor() { return output; } });
  vi.stubGlobal("AudioWorkletNode", class { port = { onmessage: null }; disconnect() {} });
  const getUserMedia = vi.fn(async (): Promise<unknown> => stream);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  const analyser = () => ({ connect: vi.fn(), getFloatTimeDomainData: (data: Float32Array) => data.fill(0.1) });
  const voice = analyser();
  const mic = analyser();
  const tones: Array<{ connect: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
  const buffers: Float32Array[] = [];
  const sources: Array<{ buffer: unknown; connect: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; onended: (() => void) | null }> = [];
  const ctx = {
    state: "suspended",
    currentTime: 1,
    destination: {},
    createAnalyser: vi.fn().mockReturnValueOnce(voice).mockReturnValueOnce(mic).mockImplementation(analyser),
    createMediaStreamDestination: () => destination,
    createMediaStreamSource: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
    createBuffer: (_channels: number, length: number, rate: number) => {
      const data = new Float32Array(length);
      buffers.push(data);
      return { duration: length / rate, getChannelData: () => data };
    },
    createBufferSource: () => {
      const source = { buffer: null, connect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null };
      sources.push(source);
      return source;
    },
    createOscillator: () => {
      const osc = { type: "", frequency: { value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null };
      tones.push(osc);
      return osc;
    },
    createGain: () => ({ gain: { value: 1, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn(), cancelScheduledValues: vi.fn(), setTargetAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() }),
    createBiquadFilter: () => ({ type: "", frequency: { value: 0 }, connect: vi.fn() }),
    audioWorklet: { addModule: vi.fn(async () => {}) },
    resume: vi.fn(async (): Promise<void> => { ctx.state = "running"; }),
    close: vi.fn(async () => {}),
  };
  return { audio: new CallAudio({ ctx, voice: output } as unknown as CallSound), ctx, output, destination, getUserMedia, micTrack, voiceTrack, voice, sources, tones, buffers };
}

afterEach(() => vi.unstubAllGlobals());

describe("CallAudio", () => {
  it("plays the voice on the element the call tap started, so a phone that wants a tap still sounds", async () => {
    const { ctx } = setup();
    let inTap = false;
    // A phone's media policy: an element plays only once a play() of its own ran inside a tap.
    class PhoneAudio {
      srcObject: unknown = null;
      paused = true;
      unlocked = false;
      play() {
        this.unlocked ||= inTap;
        if (!this.unlocked) return Promise.reject(Object.assign(new Error("tap first"), { name: "NotAllowedError" }));
        this.paused = false;
        return Promise.resolve();
      }
      pause() { this.paused = true; }
    }
    vi.stubGlobal("Audio", PhoneAudio);
    vi.stubGlobal("AudioContext", class { constructor() { return ctx; } });
    const { callAudio } = await import("./warm-audio");
    inTap = true;
    const sound = callAudio();
    inTap = false;
    expect(await new CallAudio(sound).capture(() => {})).toBe(true);
  });

  it("opens the media output after echo-cancelled capture, without a direct speaker path", async () => {
    const { audio, ctx, output, destination, getUserMedia, voice } = setup();
    expect(gainTo(voice, ctx.destination)).toBeUndefined();
    expect(output.srcObject).toBeNull();
    expect(output.play).not.toHaveBeenCalled();
    await audio.capture(() => {});
    expect(getUserMedia).toHaveBeenCalledWith({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    expect(gainTo(voice, destination)).toBeGreaterThan(0);
    expect(output.srcObject).toBe(destination.stream);
    expect(output.play).toHaveBeenCalledOnce();
    expect(getUserMedia.mock.invocationCallOrder[0]).toBeLessThan(output.play.mock.invocationCallOrder[0]!);
    audio.close();
  });

  it("keeps 24 kHz scheduling, the meter and immediate barge-in", async () => {
    const { audio, ctx, sources, voice } = setup();
    await audio.capture(() => {});
    audio.onStart = vi.fn();
    audio.onIdle = vi.fn();
    audio.play(new Int16Array(24_000));
    audio.play(new Int16Array(12_000));
    expect(sources.map((source) => source.start.mock.calls[0]![0])).toEqual([1.05, 2.05]);
    expect(sources[0]!.connect).toHaveBeenCalledWith(voice);
    expect(audio.level(true)).toBeCloseTo(0.4);
    expect(audio.playing).toBe(true);
    ctx.currentTime = 1.8;
    expect(audio.heardShare()).toBeCloseTo(0.5);
    audio.flush();
    expect(sources.every((source) => source.stop.mock.calls.length === 1 && source.onended === null)).toBe(true);
    expect(audio.playing).toBe(false);
    expect(audio.onIdle).toHaveBeenCalledOnce();
    audio.play(new Int16Array(24_000));
    expect(sources[2]!.start).toHaveBeenCalledWith(1.85);
    expect(audio.onStart).toHaveBeenCalledTimes(2);
    audio.close();
  });

  it("leaves the mic off when the call ends while the mic is still being granted", async () => {
    const { audio, ctx, output, getUserMedia, micTrack } = setup();
    let grant!: () => void;
    const stream = { getTracks: () => [micTrack], getAudioTracks: () => [micTrack] };
    getUserMedia.mockImplementationOnce(() => new Promise((resolve) => { grant = () => resolve(stream); }));
    const capture = audio.capture(() => {});
    audio.close();
    grant();
    await capture;
    expect(micTrack.stop).toHaveBeenCalled();
    expect(ctx.audioWorklet.addModule).not.toHaveBeenCalled();
    expect(output.play).not.toHaveBeenCalled();
  });

  it("turns the mic off with the call kept, and opens it again on one worklet", async () => {
    const { audio, ctx, getUserMedia, micTrack } = setup();
    await audio.capture(() => {});
    audio.stopMic();
    expect(micTrack.stop).toHaveBeenCalledOnce();
    expect(ctx.close).not.toHaveBeenCalled();
    await audio.capture(() => {});
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(ctx.audioWorklet.addModule).toHaveBeenCalledOnce();
    audio.close();
  });

  it("releases the media element and both streams on hang-up", async () => {
    const { audio, ctx, output, micTrack, voiceTrack } = setup();
    await audio.capture(() => {});
    audio.close();
    expect(output.pause).toHaveBeenCalledOnce();
    expect(output.srcObject).toBeNull();
    expect(micTrack.stop).toHaveBeenCalledOnce();
    expect(voiceTrack.stop).toHaveBeenCalledOnce();
    expect(ctx.close).toHaveBeenCalledOnce();
  });

  it("eases in the call's first 300 ms of voice only", async () => {
    const { audio, buffers } = setup();
    const loud = (ms: number) => new Int16Array(ms * 24).fill(16_384);
    audio.play(loud(200));
    audio.play(loud(200));
    audio.flush();
    audio.play(loud(200));
    const [first, second, later] = buffers;
    expect(first![0]).toBe(0);
    expect(first![2_400]).toBeCloseTo(1 / 6);
    expect(second![0]).toBeCloseTo(1 / 3);
    expect(second![2_400]).toBe(0.5);
    expect(later!.every((sample) => sample === 0.5)).toBe(true);
  });

  it("plays the voice at a calm speech level, with the boop kept at the same level beside it", async () => {
    const { audio, destination, voice, tones } = setup();
    await audio.capture(() => {});
    audio.boop();
    const level = gainTo(voice, destination)!;
    const db = 20 * Math.log10(level);
    expect(RECORDED.lufs + db).toBeGreaterThan(-21);
    expect(RECORDED.lufs + db).toBeLessThan(-19);
    expect(RECORDED.peakDb + db).toBeLessThan(-3);
    expect(gainTo(tones[0]!, destination)).toBe(level);
    audio.close();
  });

  it("remakes only the voice not yet heard at a new speed, and moves the level at once", async () => {
    const { audio, ctx, sources } = setup();
    await audio.capture(() => {});
    audio.onIdle = vi.fn();
    audio.play(new Int16Array(12_000).fill(1000));
    audio.play(new Int16Array(24_000).fill(1000));
    audio.play(new Int16Array(24_000).fill(1000));
    ctx.currentTime = 1.2;
    audio.tune(0.8, 0.6);
    expect(sources[0]!.stop).not.toHaveBeenCalled();
    expect(sources.slice(1, 3).every((source) => source.stop.mock.calls.length === 1 && source.onended === null)).toBe(true);
    const remade = sources.slice(3);
    expect(remade[0]!.start).toHaveBeenCalledWith(1.55);
    audio.endTurn();
    const seconds = sources.slice(3).reduce((sum, source) => sum + (source.buffer as { duration: number }).duration, 0);
    expect(seconds).toBeCloseTo(2 / 0.8, 1);
    expect(remade.length).toBeGreaterThan(0);
    expect(audio.onIdle).not.toHaveBeenCalled();
    const out = (audio as unknown as { out: { gain: { setTargetAtTime: ReturnType<typeof vi.fn> } } }).out;
    expect(out.gain.setTargetAtTime).toHaveBeenLastCalledWith(0.7 * 0.6, 1.2, 0.03);
    audio.close();
  });

  it("lets a second speed change remake what the first one queued", async () => {
    const { audio, ctx, sources } = setup();
    await audio.capture(() => {});
    for (let i = 0; i < 4; i++) audio.play(new Int16Array(12_000).fill(1000));
    ctx.currentTime = 1.2;
    audio.tune(0.8, 1);
    const remade = sources.length;
    ctx.currentTime = 1.9;
    audio.tune(1.2, 1);
    const live = (source: (typeof sources)[number]) => source.stop.mock.calls.length === 0;
    expect(sources.slice(1, remade).filter((source) => live(source) && source.start.mock.calls[0]![0] > 1.9)).toHaveLength(0);
    audio.endTurn();
    const seconds = sources.slice(1).filter(live).reduce((sum, source) => sum + (source.buffer as { duration: number }).duration, 0);
    expect(seconds).toBeLessThan(1.5 / 0.8 - 0.3);
    audio.close();
  });

  it("keeps an earlier reply still queued when the speed changes during the next one", async () => {
    const { audio, ctx, sources } = setup();
    await audio.capture(() => {});
    audio.play(new Int16Array(24_000).fill(1000));
    audio.play(new Int16Array(24_000).fill(1000));
    audio.endTurn();
    audio.play(new Int16Array(2_400).fill(1000));
    ctx.currentTime = 1.5;
    audio.tune(0.8, 1);
    audio.endTurn();
    expect(sources[1]!.stop).not.toHaveBeenCalled();
    const seconds = sources.filter((source) => source.stop.mock.calls.length === 0).reduce((sum, source) => sum + (source.buffer as { duration: number }).duration, 0);
    expect(seconds).toBeGreaterThan(2 + 0.1 / 0.8 - 0.02);
    audio.close();
  });

  it("plays at speed 1 exactly as it arrives", async () => {
    const { audio, buffers } = setup();
    await audio.capture(() => {});
    audio.tune(1, 1);
    const pcm = Int16Array.from({ length: 30_000 }, (_, i) => Math.round(8000 * Math.sin(i / 7)));
    audio.play(pcm);
    audio.endTurn();
    expect(buffers).toHaveLength(1);
    expect(buffers[0]![20_000]).toBeCloseTo(pcm[20_000]! / 32768, 6);
    audio.close();
  });

  it("lets the boop finish before releasing the output", async () => {
    vi.useFakeTimers();
    try {
      const { audio, ctx, output, micTrack, voiceTrack, tones } = setup();
      await audio.capture(() => {});
      audio.boop();
      expect(tones).toHaveLength(1);
      audio.close();
      expect(micTrack.stop).toHaveBeenCalledOnce();
      expect(output.pause).not.toHaveBeenCalled();
      expect(ctx.close).not.toHaveBeenCalled();
      vi.advanceTimersByTime(400);
      expect(output.pause).toHaveBeenCalledOnce();
      expect(voiceTrack.stop).toHaveBeenCalledOnce();
      expect(ctx.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a blocked output instead of silently connecting, and never as a mic error", async () => {
    const { audio, output } = setup();
    output.play.mockRejectedValueOnce(Object.assign(new Error("Playback blocked"), { name: "NotAllowedError" }));
    await expect(audio.capture(() => {})).resolves.toBe(false);
    audio.close();
  });

  it("reports a context that will not resume without a tap instead of hanging", async () => {
    vi.useFakeTimers();
    try {
      const { audio, ctx } = setup();
      ctx.resume.mockReturnValueOnce(new Promise<void>(() => {}));
      const capture = audio.capture(() => {});
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(capture).resolves.toBe(false);
      audio.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes the context and the output on return", async () => {
    const { audio, ctx, output } = setup();
    await audio.capture(() => {});
    ctx.state = "suspended";
    output.pause();
    await expect(audio.heal()).resolves.toBe(true);
    expect(ctx.state).toBe("running");
    expect(output.paused).toBe(false);
    audio.close();
  });

  it("reopens an ended or muted mic on return, and hang-up stops the new one", async () => {
    const { audio, getUserMedia, micTrack } = setup();
    await audio.capture(() => {});
    const track = () => ({ stop: vi.fn(), readyState: "live", muted: false });
    const ended = track();
    const muted = track();
    getUserMedia.mockResolvedValueOnce({ getTracks: () => [ended], getAudioTracks: () => [ended] });
    getUserMedia.mockResolvedValueOnce({ getTracks: () => [muted], getAudioTracks: () => [muted] });
    await expect(audio.heal()).resolves.toBe(true);
    expect(getUserMedia).toHaveBeenCalledOnce();
    micTrack.readyState = "ended";
    await expect(audio.heal()).resolves.toBe(true);
    expect(micTrack.stop).toHaveBeenCalled();
    ended.muted = true;
    await expect(audio.heal()).resolves.toBe(true);
    expect(ended.stop).toHaveBeenCalled();
    expect(getUserMedia).toHaveBeenCalledTimes(3);
    audio.close();
    expect(muted.stop).toHaveBeenCalledOnce();
  });

  it("opens a stopped speaker only behind the reopened mic, so Android keeps it on call volume", async () => {
    const { audio, output, getUserMedia, micTrack } = setup();
    await audio.capture(() => {});
    micTrack.readyState = "ended";
    output.pause();
    output.play.mockClear();
    const next = { stop: vi.fn(), readyState: "live", muted: false };
    let grant!: (stream: unknown) => void;
    getUserMedia.mockReturnValueOnce(new Promise((resolve) => { grant = resolve; }));
    const healing = audio.heal();
    expect(output.play).not.toHaveBeenCalled();
    grant({ getTracks: () => [next], getAudioTracks: () => [next] });
    await expect(healing).resolves.toBe(true);
    expect(output.play).toHaveBeenCalledOnce();
    expect(getUserMedia.mock.invocationCallOrder.at(-1)).toBeLessThan(output.play.mock.invocationCallOrder[0]!);
    audio.close();
  });

  it("leaves a stopped speaker shut when the mic does not come back", async () => {
    const { audio, output, getUserMedia, micTrack } = setup();
    await audio.capture(() => {});
    micTrack.readyState = "ended";
    output.pause();
    output.play.mockClear();
    getUserMedia.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    await expect(audio.heal()).resolves.toBe(false);
    expect(output.play).not.toHaveBeenCalled();
    audio.close();
  });

  it("says so when the phone wants a tap before audio plays again", async () => {
    vi.useFakeTimers();
    try {
      const { audio, ctx, output } = setup();
      await audio.capture(() => {});
      ctx.state = "suspended";
      ctx.resume.mockReturnValueOnce(new Promise(() => {}));
      const waiting = audio.heal();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(waiting).resolves.toBe(false);
      output.pause();
      output.play.mockRejectedValueOnce(new DOMException("needs a tap", "NotAllowedError"));
      await expect(audio.heal()).resolves.toBe(false);
      await expect(audio.heal()).resolves.toBe(true);
      audio.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a mic that reopens after hang-up", async () => {
    const { audio, getUserMedia, micTrack } = setup();
    await audio.capture(() => {});
    const late = { stop: vi.fn(), readyState: "live", muted: false };
    let grant!: (stream: unknown) => void;
    getUserMedia.mockReturnValueOnce(new Promise((resolve) => { grant = resolve; }));
    micTrack.readyState = "ended";
    const healing = audio.heal();
    audio.close();
    grant({ getTracks: () => [late], getAudioTracks: () => [late] });
    await expect(healing).resolves.toBe(false);
    expect(late.stop).toHaveBeenCalledOnce();
  });
});
