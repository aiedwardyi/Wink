// The Carbon voice audit's findings by id (F1, F2, ...), replayed. Fake engine and fake audio port only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LIVE_VAD } from "../../../shared/live-call";
import { LiveCall, type CallAudioPort, type Posted } from "./controller";
import type { LiveEngine, LiveEvents } from "./engine";
import { callsVoice } from "./guard";
import { OpenLines } from "./quick";

const CALL = "c-0123456789ab";
const pcm = new Int16Array([500, -500]);

class FakeEngine implements LiveEngine {
  events!: LiveEvents;
  texts: string[] = [];
  contexts: string[] = [];
  results: Array<{ id: string; result: unknown }> = [];
  closed = false;
  connect(_session: unknown, events: LiveEvents) { this.events = events; }
  sendAudio() {}
  audioPaused() {}
  sendText(text: string) { this.texts.push(text); }
  sendContext(text: string) { this.contexts.push(text); }
  sendToolResult(ids: string[], _name: string, result: unknown) { for (const id of ids) this.results.push({ id, result }); }
  close() { this.closed = true; }
}

function fakeAudio() {
  const audio = {
    playing: false as boolean,
    played: 0,
    captured: true as boolean | Error,
    async capture() {
      if (audio.captured instanceof Error) throw audio.captured;
      return audio.captured;
    },
    async heal() { return true; },
    stopMic() {},
    play() { audio.played += 1; },
    endTurn() {},
    tune() {},
    flush() {},
    close() {},
    boop() {},
    heardShare: () => 1,
    micLevel: () => 0,
    onIdle: () => {},
    onStart: () => {},
  };
  return audio satisfies CallAudioPort;
}

function setup(opts: { prefs?: Record<string, unknown>; audio?: ReturnType<typeof fakeAudio> } = {}) {
  const audio = opts.audio ?? fakeAudio();
  const engines: FakeEngine[] = [];
  const posts: Array<{ path: string; body: any }> = [];
  const call = new LiveCall({
    botId: "b1",
    botName: "Nova",
    device: "phone",
    engine: () => { const engine = new FakeEngine(); engines.push(engine); return engine; },
    audio,
    prefs: opts.prefs,
    post: async (path, body: any): Promise<Posted> => {
      posts.push({ path, body });
      if (path.endsWith("/messages")) return { status: 202, data: { ok: true } };
      if (path.endsWith("/call/token")) return { status: 200, data: { callId: CALL, url: "wss://x", token: "t", model: "m", voice: body.call?.voice ?? "Aoede", locale: body.call?.language ?? "en" } };
      return { status: 200, data: {} };
    },
  });
  return { call, audio, engines, posts, engine: () => engines.at(-1)! };
}

async function live(opts: Parameters<typeof setup>[0] = {}) {
  const s = setup(opts);
  await s.call.start();
  s.engine().events.ready();
  s.engine().events.turnDone();
  return s;
}

const sent = (posts: Array<{ path: string; body: any }>) => posts.filter((p) => p.path === "/api/bots/b1/messages").map((p) => p.body.text);
const flush = () => vi.advanceTimersByTimeAsync(0);
const quiet = () => vi.advanceTimersByTimeAsync(LIVE_VAD.silenceDurationMs);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("crypto", { randomUUID: () => "send-1" });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("F1 a pick made just before calling", () => {
  it("rides the first token, before the bot's own save lands", async () => {
    const { call, posts } = setup({ prefs: { voice: "Fenrir", style: "lively" } });
    await call.start();
    expect(posts[0]!.body.call).toEqual({ voice: "Fenrir", style: "lively" });
  });
});

describe("F2 talk before a spoken yes on an open card", () => {
  it.each(["Hold on.", "Oh, yes.", "Let me see."])("%s then Yes still answers the card", async (first) => {
    const { call, engine, posts } = await live();
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Fix the login page." } }]);
    engine().events.heard(first);
    await quiet();
    engine().events.heard(" Yes.");
    await quiet();
    await flush();
    expect(call.state().pending).toBeUndefined();
    expect(sent(posts)).toEqual(["Fix the login page."]);
  });
});

describe("F4 a voice the phone will not play yet", () => {
  it("waits on a tap instead of failing the call as a blocked mic", async () => {
    const audio = fakeAudio();
    audio.captured = false;
    const { call, engine } = setup({ audio });
    await call.start();
    engine().events.ready();
    expect(call.state()).toMatchObject({ status: "paused", error: undefined });
  });
});

describe("F5 waking with the name and a request", () => {
  it("a leading name or hello-name with a request wakes it; a name in talk does not", () => {
    for (const line of ["Hey Nova, check the build.", "Nova, what's the status?", "노바야 로그 확인해 줘"]) expect([line, callsVoice(line, line.startsWith("노바") ? "노바" : "Nova")]).toEqual([line, true]);
    for (const line of ["Nova is great.", "Ask Nova now", "Nova, be quiet please.", "Novas are bright, right?"]) expect([line, callsVoice(line, "Nova")]).toEqual([line, false]);
  });

  it("a voice called by its Korean spelling wakes", () => {
    expect(callsVoice("제퍼야", "Nova", ["Zephyr"])).toBe(true);
    expect(callsVoice("펜리르, 들려?", "Nova", ["Fenrir"])).toBe(true);
  });

  it("the reply to the waking request plays", async () => {
    const { call, engine, audio } = await live();
    engine().events.heard("Be quiet.");
    engine().events.answering();
    engine().events.turnDone();
    expect(call.state().hushed).toBe(true);
    engine().events.heard("Hey Nova, check the build.");
    engine().events.answering();
    engine().events.audio(pcm);
    expect(call.state().hushed).toBeUndefined();
    expect(audio.played).toBe(1);
  });
});

describe("F6 words for the voice are never sent on hang-up", () => {
  it("a line the voice hushed on is not an order", async () => {
    const { call, engine, posts } = await live();
    engine().events.heard("Hold the line while I grab a coffee.");
    engine().events.toolCall([{ id: "h1", name: "hush", args: {} }]);
    call.end();
    await flush();
    expect(sent(posts)).toEqual([]);
  });

  it("everyday goodbyes are small talk", () => {
    for (const line of ["Thanks a lot, bye.", "Thank you so much, bye!", "Thank you very much.", "이제 끊을게", "그럼 끊을게요", "수고했어", "수고하셨습니다", "이만 끊을게요"]) {
      const open = new OpenLines();
      open.add(1, line);
      expect([line, open.text()]).toEqual([line, ""]);
    }
  });
});

describe("F7 one ack per answer", () => {
  it("the next answer after an ack keeps its first words when they come before his", async () => {
    const { engine, audio } = await live();
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Fix it." } }]);
    engine().events.heard("Yes.");
    engine().events.answering();
    engine().events.said("On it.");
    engine().events.audio(pcm);
    engine().events.turnDone();
    await flush();
    const before = audio.played;
    engine().events.answering();
    engine().events.audio(pcm);
    engine().events.said("The build");
    engine().events.heard("Is the build green?");
    engine().events.audio(pcm);
    engine().events.said(" is green.");
    engine().events.turnDone();
    expect(audio.played - before).toBe(2);
  });

  it("a yes said as it is tapped, heard late, is acked once", async () => {
    const { call, engine, audio } = await live();
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Fix it." } }]);
    await call.answer(true);
    engine().events.answering();
    engine().events.said("On it.");
    engine().events.audio(pcm);
    engine().events.turnDone();
    const before = audio.played;
    engine().events.heard("Yes.");
    engine().events.answering();
    engine().events.said("On it.");
    engine().events.audio(pcm);
    engine().events.turnDone();
    expect(audio.played).toBe(before);
  });

  it("a late yes heard while the second ack streams keeps it held", async () => {
    const { call, engine, audio } = await live();
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Fix it." } }]);
    await call.answer(true);
    engine().events.answering();
    engine().events.said("On it.");
    engine().events.audio(pcm);
    engine().events.turnDone();
    const before = audio.played;
    engine().events.answering();
    engine().events.audio(pcm);
    engine().events.heard("Yes.");
    engine().events.said("On it.");
    engine().events.turnDone();
    expect(audio.played).toBe(before);
  });
});

describe("F8 a swap mid-call", () => {
  it("waits for an open card's answer before the new voice takes over", async () => {
    const { call, engines } = await live();
    engines[0]!.events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Fix it." } }]);
    call.retune({ voice: "Fenrir" });
    await flush();
    engines[1]!.events.ready();
    expect(engines[0]!.closed).toBe(false);
    engines[0]!.events.heard("Yes.");
    await quiet();
    await flush();
    engines[0]!.events.answering();
    engines[0]!.events.said("On it.");
    engines[0]!.events.turnDone();
    expect(engines[0]!.closed).toBe(true);
  });

  it("the new voice keeps a language they asked for", async () => {
    const { call, engines } = await live();
    engines[0]!.events.heard("Can you speak Japanese?");
    engines[0]!.events.answering();
    engines[0]!.events.turnDone();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(engines[0]!.texts.join(" ")).toContain("speak only Japanese");
    engines[0]!.events.answering();
    engines[0]!.events.said("はい、日本語で話します。");
    engines[0]!.events.turnDone();
    call.retune({ voice: "Fenrir" });
    await flush();
    engines[1]!.events.ready();
    expect(engines[0]!.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(engines[1]!.contexts.join(" ")).toContain("speak only Japanese");
  });
});

describe("F10 the status a call connects into", () => {
  it("shows working when the bot is already busy", async () => {
    const { call, engine } = setup();
    call.observe({ busy: true, messages: [] });
    await call.start();
    engine().events.ready();
    expect(call.state().status).toBe("working");
  });
});
