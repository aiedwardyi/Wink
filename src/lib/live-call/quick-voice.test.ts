// A quick call: say it and hang up, and the words still land as his message. Fake engine and fake audio port only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CallLine } from "../../../shared/live-call";
import { LiveCall, type CallAudioPort, type Posted } from "./controller";
import type { LiveEngine, LiveEvents } from "./engine";

const CALL = "c-0123456789ab";
const GREETING = /^\[Wink\] The call just started/;
// A frame is 40 ms of 16 kHz mic audio; a word's frame carries its index so the fake engine can "hear" it.
const SPEECH = 6_000;

class FakeEngine implements LiveEngine {
  events!: LiveEvents;
  texts: string[] = [];
  frames: Int16Array[] = [];
  paused = 0;
  closed = false;
  private heardUpTo = 0;
  constructor(private readonly words: string[]) {}
  connect(_session: unknown, events: LiveEvents) { this.events = events; }
  sendAudio(pcm: ArrayBuffer) { this.frames.push(new Int16Array(pcm)); }
  audioPaused() { this.paused += 1; }
  sendText(text: string) { this.texts.push(text); }
  sendContext() {}
  sendToolResult() {}
  close() { this.closed = true; }
  /** Google's input transcript: every word in the audio it has received so far. */
  transcribe() {
    const said = this.frames.slice(this.heardUpTo).filter((pcm) => pcm[0]! >= SPEECH).map((pcm) => this.words[pcm[0]! - SPEECH]!);
    this.heardUpTo = this.frames.length;
    if (said.length) this.events.heard(` ${said.join(" ")}`);
  }
}

type Mic = CallAudioPort & { word(index: number): void; hiss(): void; captures: number[]; stops: number };

function fakeAudio(clock: () => number): Mic {
  let frame: (pcm: ArrayBuffer) => void = () => {};
  return {
    playing: false,
    captures: [],
    stops: 0,
    async capture(onFrame) { this.captures.push(clock()); frame = onFrame; },
    async heal() { return true; },
    stopMic() { this.stops += 1; },
    play() {},
    flush() {},
    close() {},
    boop() {},
    heardShare: () => 1,
    micLevel: () => 0.2,
    onIdle: () => {},
    onStart: () => {},
    word(index) { frame(new Int16Array(640).fill(SPEECH + index).buffer); },
    hiss() { frame(new Int16Array(640).fill(20).buffer); },
  };
}

function setup(opts: { words?: string[]; tokenMs?: number; responses?: Record<string, Posted> } = {}) {
  let t = 0;
  const clock = () => t;
  const audio = fakeAudio(clock);
  const engines: FakeEngine[] = [];
  const posts: Array<{ path: string; body: any; at: number }> = [];
  const call = new LiveCall({
    botId: "b1",
    botName: "Nova",
    device: "phone",
    engine: () => { const engine = new FakeEngine(opts.words ?? []); engines.push(engine); return engine; },
    audio,
    now: clock,
    post: async (path, body) => {
      posts.push({ path, body, at: t });
      const hit = Object.entries(opts.responses ?? {}).find(([suffix]) => path.endsWith(suffix));
      if (hit) return hit[1];
      if (path.endsWith("/call/token")) {
        if (opts.tokenMs) await new Promise((resolve) => setTimeout(resolve, opts.tokenMs));
        return { status: 200, data: { callId: CALL, url: "wss://x", token: "t", model: "m", voice: "Aoede" } };
      }
      return { status: 200, data: {} };
    },
  });
  const tick = async (ms: number) => {
    t += ms;
    await vi.advanceTimersByTimeAsync(ms);
  };
  return { call, audio, engines, engine: () => engines.at(-1)!, posts, tick };
}

const sent = (posts: Array<{ path: string; body: any }>) => posts.filter((p) => p.path === "/api/bots/b1/messages").map((p) => p.body);
const linesOf = (posts: Array<{ path: string; body: any }>) => posts.filter((p) => p.path.endsWith("/call/lines")).flatMap((p) => p.body.lines.map((line: CallLine) => `${line.who}: ${line.text}`));
const ends = (posts: Array<{ path: string }>) => posts.filter((p) => p.path.endsWith("/call/end")).length;
const ACCEPTED: Posted = { status: 202, data: { ok: true } };

/** Live past its greeting, with the mic quiet. */
async function live(opts: Parameters<typeof setup>[0] = {}) {
  const s = setup({ responses: { "/messages": ACCEPTED }, ...opts });
  await s.call.start();
  s.engine().events.ready();
  s.engine().events.turnDone();
  await s.tick(5_000);
  return s;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("crypto", { randomUUID: () => "send-1" });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("hang-up keeps his words", () => {
  it("waits for the last words still in flight and sends the line to the bot as his message", async () => {
    const { call, audio, engine, posts, tick } = await live();
    audio.word(0);
    engine().events.heard("Hey, rename the logo");
    await tick(200);
    audio.word(0);
    call.end();
    expect(call.state().status).toBe("ended");
    expect(engine().paused).toBe(1);
    await tick(300);
    engine().events.heard(" file real quick.");
    await tick(1_000);
    expect(engine().closed).toBe(true);
    expect(linesOf(posts)).toEqual(["user: Hey, rename the logo file real quick."]);
    expect(sent(posts)).toEqual([expect.objectContaining({ text: "Hey, rename the logo file real quick.", call: { id: CALL, order: true } })]);
    expect(posts.map((p) => p.path.split("/").at(-1))).toEqual(["token", "lines", "messages", "end"]);
  });

  it("waits at most about a second", async () => {
    const { call, audio, engine, posts, tick } = await live();
    audio.word(0);
    engine().events.heard("Push the branch");
    call.end();
    await tick(900);
    expect(sent(posts)).toEqual([]);
    await tick(200);
    expect(sent(posts).map((body) => body.text)).toEqual(["Push the branch"]);
    expect(ends(posts)).toBe(1);
  });

  it("sends the line the voice was still answering when he hung up", async () => {
    const { call, engine, posts, tick } = await live();
    engine().events.heard("Merge the picker fix when CI is green.");
    engine().events.answering();
    engine().events.said("Sure, I'll");
    call.end();
    await tick(1_100);
    expect(sent(posts).map((body) => body.text)).toEqual(["Merge the picker fix when CI is green."]);
  });

  it("sends his words, not a Not sent line, when he hangs up on the voice's offer", async () => {
    const { call, engine, posts, tick } = await live();
    engine().events.heard("Open the Orbit folder.");
    engine().events.answering();
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Open the Orbit folder." } }]);
    engine().events.said("Opening the Orbit folder, okay?");
    engine().events.turnDone();
    call.end();
    await tick(1_100);
    expect(sent(posts)).toEqual([expect.objectContaining({ text: "Open the Orbit folder.", call: { id: CALL, order: true } })]);
    expect(linesOf(posts).filter((line) => line.includes("Not sent"))).toEqual([]);
  });

  it("joins every line said since the call last dealt with one", async () => {
    const { call, engine, posts, tick } = await live();
    engine().events.heard("Check the build.");
    engine().events.answering();
    engine().events.interrupted();
    engine().events.heard("And push it if it's green.");
    call.end();
    await tick(1_100);
    expect(sent(posts).map((body) => body.text)).toEqual(["Check the build. And push it if it's green."]);
  });

  it("sends nothing the bot already has", async () => {
    const { call, engine, posts, tick } = await live();
    engine().events.heard("When do the evals finish?");
    engine().events.answering();
    engine().events.toolCall([{ id: "t1", name: "ask", args: { question: "When do the evals finish?" } }]);
    await tick(0);
    call.end();
    await tick(1_100);
    expect(sent(posts).map((body) => body.text)).toEqual(["When do the evals finish?"]);
  });

  it("sends nothing for a line the voice already answered", async () => {
    const { call, engine, posts, tick } = await live();
    engine().events.heard("Is the build still running?");
    engine().events.answering();
    engine().events.said("Yes, it's on step three.");
    engine().events.turnDone();
    call.end();
    await tick(1_100);
    expect(sent(posts)).toEqual([]);
  });

  it("sends nothing after he said no to the offer", async () => {
    const { call, engine, posts, tick } = await live();
    engine().events.heard("Delete the old branches.");
    engine().events.answering();
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Delete the old branches." } }]);
    engine().events.turnDone();
    engine().events.heard("No, leave them.");
    call.end();
    await tick(1_100);
    expect(sent(posts)).toEqual([]);
  });

  it("sends nothing said while the voice was told to be quiet", async () => {
    const { call, engine, posts, tick } = await live();
    engine().events.heard("Be quiet.");
    engine().events.answering();
    engine().events.turnDone();
    engine().events.heard("Did you feed the cat?");
    call.end();
    await tick(1_100);
    expect(sent(posts)).toEqual([]);
  });

  it("hangs up at once when no words are in flight", async () => {
    const { call, engine, posts, tick } = await live();
    engine().events.heard("Is the build still running?");
    engine().events.answering();
    engine().events.said("Yes.");
    engine().events.turnDone();
    call.end();
    await tick(0);
    expect(engine().closed).toBe(true);
    expect(ends(posts)).toBe(1);
  });
});

describe("the mic is live from the tap", () => {
  const WORDS = ["hey", "do", "this", "real", "quick", "rename", "the", "logo", "file", "please"];

  // Five fake-engine runs: the token takes 150-900 ms, the socket 250 ms more; a word every 100 ms from the tap.
  it.each([150, 300, 500, 700, 900])("keeps every word said in the first second (token %i ms)", async (tokenMs) => {
    const { call, audio, engine, engines, posts, tick } = setup({ words: WORDS, tokenMs });
    const started = call.start();
    let connectAt: number | undefined;
    let ready = false;
    for (let at = 0; !ready || at < 1_000; at += 50) {
      if (at % 100 === 0 && at < 1_000) audio.word(at / 100);
      else audio.hiss();
      await tick(50);
      if (engines.length && connectAt === undefined) connectAt = at + 50;
      if (!ready && connectAt !== undefined && at + 50 >= connectAt + 250) {
        engine().events.ready();
        ready = true;
      }
    }
    await started;
    engine().transcribe();
    engine().events.answering();
    expect(linesOf(posts)).toEqual([`user: ${WORDS.join(" ")}`]);
  });

  it("opens the mic before the call token comes back", async () => {
    const { call, audio, tick } = setup({ tokenMs: 400 });
    const started = call.start();
    await tick(0);
    expect(audio.captures).toEqual([0]);
    await tick(400);
    await started;
    expect(audio.captures).toEqual([0]);
  });

  it("turns the mic back off when the call needs a key", async () => {
    const { call, audio, tick } = setup({ responses: { "/call/token": { status: 409, data: {} } } });
    await call.start();
    await tick(0);
    expect(call.state().status).toBe("needsKey");
    expect(audio.stops).toBe(1);
  });
});

describe("say it and hang up", () => {
  it("talks from the tap, hangs up, and the bot gets his words as his message with no greeting", async () => {
    const words = ["hey", "do", "this", "real", "quick"];
    const { call, audio, engine, posts, tick } = setup({ words, tokenMs: 500, responses: { "/messages": ACCEPTED } });
    const started = call.start();
    for (let i = 0; i < words.length; i++) {
      audio.word(i);
      await tick(200);
    }
    await started;
    engine().events.ready();
    expect(engine().texts).toEqual([]);
    engine().transcribe();
    call.end();
    expect(call.state().status).toBe("ended");
    await tick(1_100);
    expect(sent(posts)).toEqual([expect.objectContaining({ text: "hey do this real quick", call: { id: CALL, order: true } })]);
    expect(engine().texts).toEqual([]);
    expect(ends(posts)).toBe(1);
  });
});

describe("a quick call never waits on the greeting", () => {
  it("drops the greeting when he is already talking as the call connects", async () => {
    const { call, audio, engine, tick } = setup({ words: ["rename", "it"], tokenMs: 300 });
    const started = call.start();
    audio.word(0);
    await tick(100);
    audio.word(1);
    await tick(300);
    await started;
    engine().events.ready();
    expect(engine().texts.filter((text) => GREETING.test(text))).toEqual([]);
    engine().transcribe();
    engine().events.answering();
    engine().events.said("Renaming it.");
    engine().events.turnDone();
    await tick(5_000);
    expect(engine().texts.filter((text) => GREETING.test(text))).toEqual([]);
  });

  it("still greets a quiet room", async () => {
    const { call, audio, engine, tick } = setup({ tokenMs: 300 });
    const started = call.start();
    audio.hiss();
    await tick(300);
    await started;
    engine().events.ready();
    expect(engine().texts.filter((text) => GREETING.test(text))).toHaveLength(1);
  });

  it("drops a greeting still waiting its turn once he speaks", async () => {
    const { call, engine, tick } = setup();
    await call.start();
    (call as unknown as { stalled: boolean }).stalled = true;
    engine().events.ready();
    expect(engine().texts).toEqual([]);
    engine().events.heard("Check the build.");
    engine().events.answering();
    engine().events.said("It's green.");
    engine().events.turnDone();
    call.resume();
    await tick(5_000);
    expect(engine().texts.filter((text) => GREETING.test(text))).toEqual([]);
  });
});
