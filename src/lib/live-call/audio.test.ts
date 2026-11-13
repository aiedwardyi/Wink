import { afterEach, describe, expect, it, vi } from "vitest";

import { CallAudio } from "./audio";

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
    createAnalyser: vi.fn().mockReturnValueOnce(voice).mockReturnValueOnce(mic),
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
    createGain: () => ({ gain: { value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn(), cancelScheduledValues: vi.fn(), setTargetAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() }),
    createBiquadFilter: () => ({ type: "", frequency: { value: 0 }, connect: vi.fn() }),
    audioWorklet: { addModule: vi.fn(async () => {}) },
    resume: vi.fn(async (): Promise<void> => { ctx.state = "running"; }),
    close: vi.fn(async () => {}),
  };
  return { audio: new CallAudio(ctx as unknown as AudioContext), ctx, output, destination, getUserMedia, micTrack, voiceTrack, voice, sources, tones, buffers };
}

afterEach(() => vi.unstubAllGlobals());

describe("CallAudio", () => {
  it("opens the media output after echo-cancelled capture, without a direct speaker path", async () => {
    const { audio, ctx, output, destination, getUserMedia, voice } = setup();
    expect(voice.connect).not.toHaveBeenCalledWith(ctx.destination);
    expect(output.srcObject).toBeNull();
    expect(output.play).not.toHaveBeenCalled();
    await audio.capture(() => {});
    expect(getUserMedia).toHaveBeenCalledWith({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    expect(voice.connect).toHaveBeenCalledWith(destination);
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

  it("reports a blocked output instead of silently connecting", async () => {
    const { audio, output } = setup();
    output.play.mockRejectedValueOnce(new Error("Playback blocked"));
    await expect(audio.capture(() => {})).rejects.toThrow("Playback blocked");
    audio.close();
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
