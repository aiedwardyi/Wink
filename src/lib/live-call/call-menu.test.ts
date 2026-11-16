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

async function started(voice = "Alnilam") {
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
  engines[0]!.events.ready();
  engines[0]!.events.turnDone();
  return { call, engines, posts, audio };
}

afterEach(() => { vi.useRealTimers(); });

describe("call menu picks mid-call", () => {
  it("speed, style and this device's volume reach the next words heard without a new session", async () => {
    const { call, posts, audio } = await started();
    call.retune({ speed: 0.8 });
    call.retune({ speed: 0.8, style: "calm" });
    call.retune({ speed: 0.8, style: "calm" }, 0.5);
    expect(audio.tunes.slice(-3)).toEqual([[0.8, 1], [0.8, 0.6], [0.8, 0.3]]);
    await flush();
    expect(posts.filter((post) => post.body.swap)).toHaveLength(1);
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
