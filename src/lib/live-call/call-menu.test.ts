import { afterEach, describe, expect, it, vi } from "vitest";

import { LiveCall, type CallAudioPort, type Posted } from "./controller";
import type { LiveEngine, LiveEvents } from "./engine";

class FakeEngine implements LiveEngine {
  events!: LiveEvents;
  texts: string[] = [];
  contexts: string[] = [];
  audio = 0;
  closed = false;
  connect(_session: unknown, events: LiveEvents) { this.events = events; }
  sendAudio() { this.audio += 1; }
  audioPaused() {}
  sendText(text: string) { this.texts.push(text); }
  sendContext(text: string) { this.contexts.push(text); }
  sendToolResult() {}
  close() { this.closed = true; }
}

function fakeAudio() {
  const tunes: Array<[number, number]> = [];
  return {
    playing: false as boolean,
    tunes,
    frame: (_pcm: ArrayBuffer) => {},
    async capture(onFrame: (pcm: ArrayBuffer) => void) { this.frame = onFrame; },
    stopMic() {},
    async heal() { return true; },
    play() {},
    endTurn() {},
    tune(speed: number, level: number) { tunes.push([speed, level]); },
    flush() {},
    close() {},
    boop() {},
    heardShare: () => 1,
    micLevel: () => 0,
    onIdle: () => {},
    onStart: () => {},
  } satisfies CallAudioPort & Record<string, unknown>;
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const token = (body: Record<string, unknown>): Posted => ({ status: 200, data: { callId: "c-0123456789ab", url: "wss://x", token: "t", model: "m", voice: "Aoede", locale: "en", ...body } });

async function started(voice = "Alnilam", ready = true) {
  vi.useFakeTimers();
  const engines: FakeEngine[] = [];
  const posts: Array<{ path: string; body: any }> = [];
  const audio = fakeAudio();
  const call = new LiveCall({
    botId: "b1",
    botName: "Nova",
    device: "desktop",
    engine: () => { const engine = new FakeEngine(); engines.push(engine); return engine; },
    audio,
    post: async (path, body: any) => {
      posts.push({ path, body });
      return path.endsWith("/call/token") ? token(body.swap ? { voice } : {}) : { status: 200, data: {} };
    },
  });
  call.retune({});
  await call.start();
  if (!ready) return { call, engines, posts, audio };
  engines[0]!.events.ready();
  engines[0]!.events.turnDone();
  return { call, engines, posts, audio };
}

afterEach(() => { vi.useRealTimers(); });

describe("call menu picks mid-call", () => {
  it("speed and this device's volume reach the next words heard without a new session", async () => {
    const { call, posts, audio } = await started();
    call.retune({ speed: 0.8 });
    call.retune({ speed: 0.7 });
    call.retune({ speed: 0.7 }, 0.5);
    expect(audio.tunes.slice(-3)).toEqual([[0.8, 1], [0.7, 1], [0.7, 0.5]]);
    await flush();
    expect(posts.filter((post) => post.body.swap)).toHaveLength(0);
  });

  it("c-3a2c5539c0ea a saved style never changes the pace or opens a new session", async () => {
    const { call, audio, posts } = await started();
    for (const style of ["calm", "normal", "lively"] as const) call.retune({ style });
    expect(audio.tunes.slice(-3)).toEqual([[1, 1], [1, 1], [1, 1]]);
    call.retune({ speed: 1.3, style: "lively" });
    call.retune({ speed: 0.7, style: "calm" });
    expect(audio.tunes.slice(-2)).toEqual([[1.3, 1], [0.7, 1]]);
    await flush();
    expect(posts.filter((post) => post.body.swap)).toHaveLength(0);
  });

  it("a voice picked between lines is the voice of the next line", async () => {
    const { call, engines, posts, audio } = await started();
    call.retune({ voice: "Alnilam" });
    await flush();
    engines[1]!.events.ready();
    expect(engines[0]!.closed).toBe(true);
    audio.frame(new Int16Array(480).fill(5_000).buffer);
    expect(engines[1]!.audio).toBe(1);
    expect(engines[0]!.audio).toBe(0);
    engines[1]!.events.heard("Say something.");
    engines[1]!.events.answering();
    engines[1]!.events.said("Hi, it's Eddie now.");
    engines[1]!.events.turnDone();
    await flush();
    const said = posts.filter((post) => post.path.endsWith("/call/lines")).flatMap((post) => post.body.lines);
    expect(said.at(-1)).toMatchObject({ who: "voice", text: "Hi, it's Eddie now." });
  });

  it("a voice picked mid-line takes over when that line ends, so the next line is new", async () => {
    const { call, engines, audio } = await started();
    engines[0]!.events.answering();
    audio.playing = true;
    call.retune({ voice: "Alnilam" });
    await flush();
    engines[1]!.events.ready();
    engines[0]!.events.said("The build is green.");
    engines[0]!.events.turnDone();
    expect(engines[0]!.closed).toBe(false);
    audio.playing = false;
    audio.onIdle();
    expect(engines[0]!.closed).toBe(true);
    audio.frame(new Int16Array(480).fill(5_000).buffer);
    expect(engines[1]!.audio).toBe(1);
  });

  it("switching around fast, the last pick is the next line's voice and no older one plays", async () => {
    const { call, engines, posts } = await started();
    call.retune({ voice: "Alnilam" });
    await flush();
    call.retune({ voice: "Fenrir" });
    await flush();
    expect(engines[1]!.closed).toBe(true);
    engines[1]!.events.ready();
    expect(engines[0]!.closed).toBe(false);
    engines[2]!.events.ready();
    expect(engines[0]!.closed).toBe(true);
    expect(posts.filter((post) => post.body.swap).map((post) => post.body.call.voice)).toEqual(["Alnilam", "Fenrir"]);
  });

  it("a new voice opens beside the live session and takes over when it is quiet, with no gap", async () => {
    const { call, engines, posts } = await started();
    call.retune({ voice: "Alnilam" });
    await flush();
    expect(posts.at(-1)!.body).toEqual({ locale: "en", callId: "c-0123456789ab", swap: true, call: { voice: "Alnilam" } });
    expect(engines).toHaveLength(2);
    expect(engines[0]!.closed).toBe(false);
    engines[1]!.events.ready();
    expect(engines[0]!.closed).toBe(true);
    expect(call.state().status).not.toBe("failed");
    engines[1]!.events.said("Hi, it's Eddie.");
    engines[1]!.events.turnDone();
    expect(engines).toHaveLength(2);
  });

  it("lets the old voice finish its line before the new one takes over", async () => {
    const { call, engines, audio } = await started();
    engines[0]!.events.answering();
    call.retune({ voice: "Alnilam" });
    await flush();
    engines[1]!.events.ready();
    expect(engines[0]!.closed).toBe(false);
    audio.playing = true;
    engines[0]!.events.turnDone();
    expect(engines[0]!.closed).toBe(false);
    audio.playing = false;
    audio.onIdle();
    expect(engines[0]!.closed).toBe(true);
  });

  it("opens no new session for picks the live one already has", async () => {
    const { call, posts } = await started();
    call.retune({ voice: "Aoede" });
    call.retune({ voice: "Aoede", style: "normal", language: "en" });
    await flush();
    expect(posts.filter((post) => post.body.swap)).toHaveLength(0);
  });

  it("hands the new session what was said while it set up", async () => {
    const { call, engines } = await started();
    engines[0]!.events.answering();
    call.retune({ voice: "Alnilam" });
    await flush();
    engines[0]!.events.said("The build is green.");
    engines[1]!.events.ready();
    engines[0]!.events.turnDone();
    expect(engines[0]!.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(engines[1]!.contexts.join(" ")).toContain("Voice: The build is green.");
  });

  it("holds a pick made while the call connects until it is up, then swaps", async () => {
    const { call, engines, posts } = await started("Alnilam", false);
    call.retune({ voice: "Alnilam" });
    await flush();
    expect(posts.filter((post) => post.body.swap)).toHaveLength(0);
    engines[0]!.events.ready();
    expect(call.state().status).toBe("listening");
    await flush();
    expect(posts.filter((post) => post.body.swap)).toHaveLength(1);
    engines[0]!.events.turnDone();
    engines[1]!.events.ready();
    expect(engines[0]!.closed).toBe(true);
  });

  it("drops a pending new session when the line drops, and leaves no socket open after hang-up", async () => {
    const { call, engines } = await started();
    engines[0]!.events.resumable("h1");
    call.retune({ voice: "Alnilam" });
    await flush();
    engines[1]!.events.resumable("h2");
    engines[0]!.events.closed(1006, "");
    expect(engines[1]!.closed).toBe(true);
    await flush();
    engines[1]!.events.ready();
    expect(engines).toHaveLength(3);
    engines[2]!.events.ready();
    call.end();
    expect(engines.every((engine) => engine.closed)).toBe(true);
  });

  it("waits for their sentence to finish before the new voice takes over", async () => {
    const { call, engines, audio } = await started();
    call.retune({ voice: "Alnilam" });
    await flush();
    audio.frame(new Int16Array(480).fill(5_000).buffer);
    engines[1]!.events.ready();
    expect(engines[0]!.closed).toBe(false);
    engines[0]!.events.heard("Read me the plan.");
    engines[0]!.events.turnDone();
    expect(engines[0]!.closed).toBe(true);
  });

  it("keeps the live session when the new one never sets up", async () => {
    const { call, engines } = await started();
    call.retune({ voice: "Alnilam" });
    await flush();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(engines[1]!.closed).toBe(true);
    expect(engines[0]!.closed).toBe(false);
    expect(call.state().status).not.toMatch(/failed|ended/);
  });

  it("drops a pending new session on hang-up", async () => {
    const { call, engines } = await started();
    call.retune({ language: "ko" });
    await flush();
    call.end();
    expect(engines.every((engine) => engine.closed)).toBe(true);
  });
});
