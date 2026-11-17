// The 1.0.264 release walk's voice findings (V#) and his 15:56 call (B#), replayed. Fake engine and fake audio port only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LiveCall, type CallAudioPort, type Posted } from "./controller";
import type { LiveEngine, LiveEvents } from "./engine";
import { looksUp, restates } from "./guard";
import { answersCard } from "./manners";

const CALL = "c-0123456789ab";
const GREETING = /^\[Wink\] The call just started/;
const SPEECH = 6_000;

class FakeEngine implements LiveEngine {
  events!: LiveEvents;
  texts: string[] = [];
  contexts: string[] = [];
  results: Array<{ id: string; result: unknown }> = [];
  frames: Int16Array[] = [];
  private heardUpTo = 0;
  constructor(private readonly words: string[]) {}
  connect(_session: unknown, events: LiveEvents) { this.events = events; }
  sendAudio(pcm: ArrayBuffer) { this.frames.push(new Int16Array(pcm)); }
  audioPaused() {}
  sendText(text: string) { this.texts.push(text); }
  sendContext(text: string) { this.contexts.push(text); }
  sendToolResult(ids: string[], _name: string, result: unknown) { for (const id of ids) this.results.push({ id, result }); }
  close() {}
  transcribe() {
    const said = this.frames.slice(this.heardUpTo).filter((pcm) => pcm[0]! >= SPEECH).map((pcm) => this.words[pcm[0]! - SPEECH]!);
    this.heardUpTo = this.frames.length;
    if (said.length) this.events.heard(` ${said.join(" ")}`);
  }
}

type Mic = CallAudioPort & { word(index: number): void; hiss(): void; click(): void };

function fakeAudio(): Mic {
  let frame: (pcm: ArrayBuffer) => void = () => {};
  return {
    playing: false,
    async capture(onFrame) { frame = onFrame; },
    async heal() { return true; },
    stopMic() {},
    play() {},
    endTurn() {},
    tune() {},
    flush() {},
    close() {},
    boop() {},
    heardShare: () => 1,
    micLevel: () => 0.2,
    onIdle: () => {},
    onStart: () => {},
    word(index) { frame(new Int16Array(640).fill(SPEECH + index).buffer); },
    hiss() { frame(new Int16Array(640).fill(20).buffer); },
    // 40 ms of room hiss with one 1.5 ms tick in it: a mouse click, a thumb leaving the glass.
    click() { const pcm = new Int16Array(640).fill(20); pcm.fill(1_500, 300, 324); frame(pcm.buffer); },
  };
}

type Reply = Posted | (() => Posted | Promise<Posted>);

function setup(opts: { words?: string[]; tokenMs?: number; responses?: Record<string, Reply> } = {}) {
  let t = 0;
  const audio = fakeAudio();
  const engines: FakeEngine[] = [];
  const posts: Array<{ path: string; body: any; at: number }> = [];
  const call = new LiveCall({
    botId: "b1",
    botName: "Nova",
    device: "phone",
    engine: () => { const engine = new FakeEngine(opts.words ?? []); engines.push(engine); return engine; },
    audio,
    now: () => t,
    post: async (path, body) => {
      posts.push({ path, body, at: t });
      const hit = Object.entries(opts.responses ?? {}).find(([suffix]) => path.endsWith(suffix));
      if (hit) return typeof hit[1] === "function" ? hit[1]() : hit[1];
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
  /** Time passing with the mic open and the room quiet, so the call never reads as stalled. */
  const wait = async (ms: number) => {
    for (let left = ms; left > 0; left -= 1_000) {
      audio.hiss();
      await tick(Math.min(1_000, left));
    }
  };
  return { call, audio, engines, engine: () => engines.at(-1)!, posts, tick, wait };
}

const ACCEPTED: Posted = { status: 202, data: { ok: true } };
const sent = (posts: Array<{ path: string; body: any }>) => posts.filter((p) => p.path === "/api/bots/b1/messages").map((p) => p.body);
const ended = (posts: Array<{ path: string; body: any }>) => posts.filter((p) => p.path.endsWith("/call/end")).map((p) => p.body);
const greetings = (engine: FakeEngine) => engine.texts.filter((text) => GREETING.test(text));
const readOut = (engine: FakeEngine) => engine.texts.filter((text) => text.includes(" replied: "));
const turn = (engine: FakeEngine, heard: string, said: string) => {
  if (heard) engine.events.heard(heard);
  engine.events.answering();
  engine.events.said(said);
  engine.events.turnDone();
};

/** Live past its greeting, with the mic quiet; the call starts at t = startAt. */
async function live(opts: Parameters<typeof setup>[0] & { startAt?: number } = {}) {
  const s = setup({ responses: { "/messages": ACCEPTED }, ...opts });
  if (opts.startAt) await s.tick(opts.startAt);
  await s.call.start();
  s.engine().events.ready();
  s.engine().events.turnDone();
  await s.wait(5_000);
  return s;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("crypto", { randomUUID: () => "send-1" });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("V1 a hang-up sends only what was for the bot", () => {
  it.each(["Okay, thanks. Bye.", "응 고마워, 끊을게.", "Stop, stop.", "Never mind.", "Okay.", "잠깐만.", "네, 감사합니다."])("%s goes nowhere", async (words) => {
    const { call, audio, engine, posts, tick } = await live();
    audio.word(0);
    engine().events.heard(words);
    await tick(300);
    call.end();
    await tick(1_100);
    expect(sent(posts)).toEqual([]);
    expect(ended(posts)).toHaveLength(1);
  });

  it("an order said before the goodbye still sends, without the goodbye", async () => {
    const { call, engine, posts, tick } = await live();
    engine().events.heard("Rename the logo file.");
    engine().events.answering();
    engine().events.said("Sure, I'll");
    engine().events.heard("Thanks, bye.");
    call.end();
    await tick(1_100);
    expect(sent(posts)).toEqual([expect.objectContaining({ text: "Rename the logo file.", call: { id: CALL, order: true } })]);
  });

  it.each(["Never mind.", "Stop, stop.", "아니야, 됐어."])("%s takes back the order said before it", async (words) => {
    const { call, engine, posts, tick } = await live();
    engine().events.heard("Delete the old branches.");
    engine().events.answering();
    engine().events.said("Sure, I'll");
    engine().events.heard(words);
    call.end();
    await tick(1_100);
    expect(sent(posts)).toEqual([]);
  });

  it.each(["Stop the build.", "Wait for CI, then merge it.", "빌드 그만 돌리고 배포해줘.", "No more retries on the deploy job."])("%s is an order and still sends", async (words) => {
    const { call, engine, posts, tick } = await live();
    engine().events.heard(words);
    call.end();
    await tick(1_100);
    expect(sent(posts).map((body) => body.text)).toEqual([words]);
  });

  it("a mutter on a misdial, hung up before the call connected, goes nowhere", async () => {
    const { call, audio, engine, posts, tick } = setup({ words: ["oops"], tokenMs: 800, responses: { "/messages": ACCEPTED } });
    const started = call.start();
    audio.word(0);
    await tick(300);
    call.end();
    await tick(500);
    await started;
    engine().events.ready();
    engine().transcribe();
    await tick(1_100);
    expect(sent(posts)).toEqual([]);
  });
});

describe("V4 a hang-up before the call connected still ends it on the server", () => {
  it("posts the call's end with the time from the tap to the hang-up", async () => {
    const words = ["rename", "the", "logo"];
    const { call, audio, engine, posts, tick } = setup({ words, tokenMs: 800, responses: { "/messages": ACCEPTED } });
    const started = call.start();
    for (let i = 0; i < words.length; i++) {
      audio.word(i);
      await tick(150);
    }
    call.end();
    await tick(400);
    await started;
    engine().events.ready();
    engine().transcribe();
    await tick(1_100);
    expect(sent(posts).map((body) => body.text)).toEqual(["rename the logo"]);
    expect(ended(posts).map((body) => [body.callId, body.stats.ms])).toEqual([[CALL, 450]]);
    expect(posts.map((p) => p.path.split("/").at(-1))).toEqual(["token", "lines", "messages", "end"]);
  });
});

describe("V2 a click while connecting does not cost the greeting", () => {
  it("one loud frame with no words in it still gets the hello", async () => {
    const { call, audio, engine, tick, wait } = setup({ tokenMs: 300 });
    const started = call.start();
    audio.hiss();
    audio.click();
    audio.hiss();
    await tick(300);
    await started;
    engine().events.ready();
    engine().transcribe();
    await wait(2_000);
    expect(greetings(engine())).toHaveLength(1);
  });

  it("a click does not hold the hello back for words", async () => {
    const { call, audio, engine, tick } = setup({ tokenMs: 300 });
    const started = call.start();
    audio.click();
    await tick(300);
    await started;
    engine().events.ready();
    expect(greetings(engine())).toHaveLength(1);
  });
});

describe("V3 the reply to an order from his last call is read out on the call back", () => {
  const order = (id: string, at: number, callId = "c-aaaaaaaaaaaa") => ({ id, role: "user", kind: "text", text: "Rename the logo file.", at, call: { id: callId, order: true } });
  const reply = (id: string, at: number, text = "Renamed it to logo-v2.png.") => ({ id, role: "bot", kind: "text", text, at });

  it("a reply that lands during the call back", async () => {
    const { call, engine, wait } = await live({ startAt: 10_000 });
    call.observe({ busy: true, messages: [order("o1", 9_000)] as never });
    await wait(5_000);
    call.observe({ busy: false, messages: [order("o1", 9_000), reply("r1", 20_000)] as never });
    await wait(30_000);
    expect(readOut(engine())).toEqual(["[Wink] Nova replied: Renamed it to logo-v2.png."]);
  });

  it("a reply that landed before he called back, once", async () => {
    const { call, engine, wait } = await live({ startAt: 60_000 });
    const rows = [order("o1", 30_000), reply("r1", 45_000)];
    call.observe({ busy: false, messages: rows as never });
    await wait(5_000);
    call.observe({ busy: false, messages: [...rows, { id: "v1", role: "bot", kind: "text", text: "Quick update: it's renamed.", at: 66_000, call: { id: CALL, voice: true } }] as never });
    await wait(5_000);
    expect(readOut(engine())).toEqual(["[Wink] Nova replied: Renamed it to logo-v2.png."]);
  });

  it("only the newest of them", async () => {
    const { call, engine, wait } = await live({ startAt: 60_000 });
    call.observe({ busy: false, messages: [order("o1", 20_000), reply("r1", 25_000, "Renamed it."), order("o2", 40_000, "c-bbbbbbbbbbbb"), reply("r2", 50_000, "Pushed the branch.")] as never });
    await wait(5_000);
    expect(readOut(engine())).toEqual(["[Wink] Nova replied: Pushed the branch."]);
  });

  it("not again once another call back has come after it", async () => {
    const { call, engine, wait } = await live({ startAt: 60_000 });
    call.observe({ busy: false, messages: [order("o1", 20_000), reply("r1", 25_000), { id: "v0", role: "bot", kind: "text", text: "Hey, I'm here.", at: 30_000, call: { id: "c-bbbbbbbbbbbb", voice: true } }] as never });
    await wait(5_000);
    expect(readOut(engine())).toEqual([]);
  });

  it("an order older than 10 minutes stays context", async () => {
    const { call, engine, wait } = await live({ startAt: 700_000 });
    call.observe({ busy: false, messages: [order("o1", 50_000), reply("r1", 706_000)] as never });
    await wait(5_000);
    expect(readOut(engine())).toEqual([]);
    expect(engine().contexts.join("\n")).toContain("do not read it out");
  });

  it("a message typed just before the call stays context", async () => {
    const { call, engine, wait } = await live({ startAt: 60_000 });
    call.observe({ busy: false, messages: [{ id: "u1", role: "user", kind: "text", text: "What broke?", at: 55_000 }, reply("r1", 66_000, "The login token expired.")] as never });
    await wait(5_000);
    expect(readOut(engine())).toEqual([]);
    expect(engine().contexts.join("\n")).toContain("do not read it out");
  });
});

describe("V5 a cut with no words does not hold later updates", () => {
  it("the bot's reply is read out without him having to speak", async () => {
    const { call, engine, wait } = await live();
    engine().events.answering();
    engine().events.said("A long reply that is still playing out.");
    await wait(5_000);
    engine().events.interrupted();
    engine().events.turnDone();
    await wait(2_000);
    call.observe({ busy: false, messages: [{ id: "m1", role: "user", kind: "text", text: "Is the build green?", at: 6_000 }, { id: "r1", role: "bot", kind: "text", text: "All green.", at: 7_000 }] as never });
    await wait(10_000);
    expect(readOut(engine())).toEqual(["[Wink] Nova replied: All green."]);
  });
});

describe("V9 the call ends once", () => {
  it("a hang-up during a reconnect whose token then fails posts one call end and stays ended", async () => {
    let tokens = 0;
    const { call, engine, posts, tick } = await live({ responses: { "/messages": ACCEPTED, "/call/token": async () => {
      if (!tokens++) return { status: 200, data: { callId: CALL, url: "wss://x", token: "t", model: "m", voice: "Aoede" } };
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { status: 502, data: { error: "Could not reach Google" } };
    } } });
    engine().events.resumable("h1");
    engine().events.closed(1006, "");
    await tick(100);
    call.end();
    await tick(2_000);
    expect(ended(posts)).toHaveLength(1);
    expect(call.state().status).toBe("ended");
  });
});

describe("V6 Korean and speech-to-text spellings", () => {
  it("card answers", () => {
    const options = ["Ship it", "Wait"];
    const answers = ["첫 번째", "1번", "일번", "일 번", "2번", "1번이요."];
    expect(answers.filter((line) => !answersCard(line, options))).toEqual([]);
    const talk = ["3번", "이번엔 좀 기다려 보자", "1번 타자가 누구였지", "일번 국도 얘기야"];
    expect(talk.filter((line) => answersCard(line, options))).toEqual([]);
  });

  it("the phone hello is no answer to a question with no choices", () => {
    expect(["여보세요", "여보세요?", "안녕"].filter((line) => answersCard(line, []))).toEqual([]);
    expect(answersCard("금요일", [])).toBe(true);
  });
});

describe("his 15:56 call, replayed", () => {
  const ASKED = "Is Edward E. Ford associated with the MicroTuber cryptocurrency project?";
  const lookup = { id: CALL, ask: true };

  it("B1 a search he asked for goes to the bot with no yes", async () => {
    const { call, engine, posts, tick } = await live();
    turn(engine(), "Can you tell me any information about Microtuber?", "I don't have any specific information about Microtuber in my current knowledge.");
    engine().events.heard("Can you search it?");
    engine().events.answering();
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "search for information about Microtuber" } }]);
    await tick(10);
    expect(call.state().pending).toBeUndefined();
    expect(sent(posts)).toEqual([expect.objectContaining({ text: "search for information about Microtuber", call: lookup })]);
    expect(engine().results).toEqual([{ id: "t1", result: "sent" }]);
  });

  it.each([
    ["Search for the old logs and delete them.", "Search for the old logs and delete them."],
    ["Can you look up the deploy script and run it?", "Look up the deploy script and run it."],
    ["검색해서 나온 파일은 지워줘.", "검색해서 나온 파일은 지워줘."],
  ])("B1 a lookup that also changes something still waits for a yes: %s", async (said, order) => {
    const { call, engine, posts, tick } = await live();
    engine().events.heard(said);
    engine().events.answering();
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order } }]);
    await tick(10);
    expect(call.state().pending?.order).toBe(order);
    expect(sent(posts)).toEqual([]);
  });

  it("B1 only a plain lookup skips the yes", () => {
    const plain = ["search for information about Microtuber", "Look up Baji Kitchen.", "search if Edward E. Ford is associated with the MicroTuber cryptocurrency project", "마이크로튜버에 대해 검색해줘.", "그 사람이 누군지 알아봐 줘", "로그 좀 찾아 주세요."];
    expect(plain.filter((order) => !looksUp(order))).toEqual([]);
    const more = ["Search for the old logs and delete them.", "Look up the config and reset it.", "Search the logs, then email them.", "검색해서 나온 파일은 지워줘.", "검색창을 왼쪽으로 옮기자.", "찾아보고 삭제하자.", "Open the forecast page."];
    expect(more.filter((order) => looksUp(order))).toEqual([]);
    const joined = ["Search the logs; email them to the team.", "Look up the server; shut it down.", "Look up the server. Shut it down.", "Search the logs, email them to the team.", "로그는 메일로 부치고 검색해줘.", "검색해줘. 그리고 서버도 내려."];
    expect(joined.filter((order) => looksUp(order))).toEqual([]);
  });

  it("B1 a lookup with a step after it waits for a yes", () => {
    const steps = ["Look up the server URL before shutting it down.", "Search for the invoice before emailing it to the team.", "Look up the backup after wiping the disk.", "Find out the price while ordering it."];
    expect(steps.filter((order) => looksUp(order))).toEqual([]);
    expect(looksUp("Look up flights to Seoul.")).toBe(true);
  });

  it("B2 a lookup that asks for more than the question sent is not a restatement", () => {
    expect(restates("search what is the weather in seoul tomorrow", ["what is the weather in seoul"])).toBe(false);
    expect(restates("search if edward e ford is associated with the microtuber cryptocurrency project", ["is edward e ford associated with the microtuber cryptocurrency project"])).toBe(true);
  });

  it("B1 a lookup takes the place of an order still waiting for a yes", async () => {
    const { call, engine, posts, tick } = await live();
    const e = engine();
    e.events.heard("Delete the old logs.");
    e.events.answering();
    e.events.toolCall([{ id: "p1", name: "propose_work", args: { order: "Delete the old logs." } }]);
    await tick(10);
    expect(call.state().pending?.order).toBe("Delete the old logs.");
    e.events.turnDone();
    e.events.heard("Search for the error message.");
    e.events.answering();
    e.events.toolCall([{ id: "p2", name: "propose_work", args: { order: "Search for the error message." } }]);
    await tick(10);
    expect(call.state().pending).toBeUndefined();
    await call.answer(true);
    await tick(10);
    expect(sent(posts).map((body) => body.text)).toEqual(["Search for the error message."]);
    expect(e.results).toEqual([{ id: "p1", result: "sent" }, { id: "p2", result: "sent" }]);
  });

  it("B2 an order already sent is not offered again, and his corrections reach the bot", async () => {
    const { call, engine, posts, tick } = await live();
    const e = engine();
    call.observe({ busy: true, messages: [] });
    e.events.heard("It's the one with the cryptocurrency. Do you see a guy named Edward E. Ford?");
    e.events.answering();
    e.events.toolCall([{ id: "a1", name: "ask", args: { question: ASKED } }]);
    await tick(10);
    e.events.said(ASKED);
    e.events.turnDone();
    turn(e, "Yeah.", "On it.");
    await tick(10);
    expect(e.texts.filter((text) => text.includes("Not done"))).toEqual([]);
    e.events.toolCall([{ id: "p1", name: "propose_work", args: { order: "search if Edward E. Ford is associated with the MicroTuber cryptocurrency project" } }]);
    await tick(10);
    expect(call.state().pending).toBeUndefined();
    expect(e.results.at(-1)).toEqual({ id: "p1", result: "already sent" });
    e.events.heard("No, no, no. Edward E.");
    e.events.answering();
    e.events.toolCall([{ id: "p2", name: "propose_work", args: { order: "search if Edward E. is associated with the MicroTuber cryptocurrency project" } }]);
    await tick(10);
    e.events.turnDone();
    e.events.heard("Yeah, but it's y i.");
    e.events.answering();
    e.events.toolCall([{ id: "p3", name: "propose_work", args: { order: "search if Edward E. Y. is associated with the MicroTuber cryptocurrency project" } }]);
    await tick(10);
    expect(call.state().pending).toBeUndefined();
    expect(sent(posts).map((body) => [body.text, body.call])).toEqual([
      [ASKED, lookup],
      ["search if Edward E. is associated with the MicroTuber cryptocurrency project", lookup],
      ["search if Edward E. Y. is associated with the MicroTuber cryptocurrency project", lookup],
    ]);
  });

  it("B2 a yes to the voice's own offer still confirms it", async () => {
    const { engine, posts, tick } = await live();
    const e = engine();
    e.events.heard("What's the weather like?");
    e.events.answering();
    e.events.toolCall([{ id: "a1", name: "ask", args: { question: "What's the weather like?" } }]);
    await tick(10);
    e.events.said("Checking. Want me to open the forecast page?");
    e.events.turnDone();
    e.events.heard("Yeah.");
    e.events.answering();
    e.events.toolCall([{ id: "p1", name: "propose_work", args: { order: "Open the forecast page." } }]);
    await tick(10);
    expect(sent(posts).map((body) => body.text)).toEqual(["What's the weather like?", "Open the forecast page."]);
  });

  it("B3 the hello reads out nothing he typed before the call", async () => {
    const { call, engine, wait } = await live({ startAt: 60_000 });
    const typed = (id: string, text: string, at: number, steered = false) => ({ id, role: "user", kind: "text", text, at, ...(steered ? { steered } : {}) });
    call.observe({ busy: false, messages: [
      typed("u1", "can u see how much usage i have", 33_000),
      typed("u2", "ur fast too!", 35_000, true),
      typed("u3", "can u give me emoticon", 41_000, true),
      { id: "r1", role: "bot", kind: "text", text: "Thanks 🙂 I'll check whether Wink shows your remaining usage.", at: 41_500 },
      typed("u4", "lol thats cute,", 49_000, true),
      { id: "r2", role: "bot", kind: "text", text: "Hehe 😊 I couldn't read your usage through my tools. Press Alt+U in Wink to see how much you have left.", at: 60_500 },
    ] as never });
    await wait(10_000);
    expect(readOut(engine())).toEqual([]);
    expect(engine().contexts.join("\n")).toContain("do not read it out");
  });
});

describe("his 11-15 calls, replayed: a turn he did not prompt never says his last line again", () => {
  const INVESTIGATING = "I'm actively investigating the code that manages your typing preferences right now.";
  const voiced = (posts: Array<{ path: string; body: any }>) => posts.filter((p) => p.path.endsWith("/call/lines")).flatMap((p) => p.body.lines).filter((line: any) => line.who === "voice").map((line: any) => line.text);
  const prompts = (engine: FakeEngine) => engine.texts.filter((text) => !GREETING.test(text));
  const speak = (engine: FakeEngine, said: string) => {
    engine.events.answering();
    engine.events.audio(new Int16Array([1]));
    engine.events.said(said);
    engine.events.turnDone();
  };
  const offer = (engine: FakeEngine, heard: string, said: string, order: string) => {
    engine.events.heard(heard);
    engine.events.answering();
    engine.events.audio(new Int16Array([1]));
    engine.events.said(said);
    engine.events.toolCall([{ id: "p1", name: "propose_work", args: { order } }]);
    engine.events.turnDone();
  };

  it.each(["the result lands first", "the voice answers first"])("12:18 a spoken no to an open offer is answered once (%s)", async (order) => {
    const { audio, engine, posts, tick } = await live();
    const e = engine();
    turn(e, "Hey, can you hear me?", "Hey, I'm here and I can hear you perfectly.");
    offer(e, "Do you know why it keeps reverting to paragraph?", "Want me to check the code that manages your typing preferences?", "Check the code that manages my typing preferences.");
    const play = vi.spyOn(audio, "play");
    e.events.heard("No, I think you're already doing it.");
    if (order === "the result lands first") await tick(1_200);
    speak(e, INVESTIGATING);
    expect(e.results).toEqual([{ id: "p1", result: "declined. They already heard you answer: say nothing more." }]);
    speak(e, INVESTIGATING);
    await tick(0);
    // One tool result is all the app sent after his "No": no [Wink] line, no context.
    expect(prompts(e)).toEqual([]);
    expect(e.contexts).toEqual([]);
    expect(voiced(posts).slice(2)).toEqual([INVESTIGATING]);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("12:24 a spoken yes gets one On it, with the stray marker turn between dropped", async () => {
    const { audio, call, engine, posts, tick } = await live();
    const e = engine();
    offer(e, "Yeah, let's do that.", "Want me to add the connecting sign removal and greeting design to your board?", "Remove the connection sign and add a greeting design to the board.");
    const play = vi.spyOn(audio, "play");
    e.events.heard("Yeah.");
    speak(e, "On it.");
    await tick(10);
    expect(e.results).toEqual([{ id: "p1", result: "sent. They already heard you answer: say nothing more." }]);
    e.events.answering();
    e.events.said("{instruction:none");
    e.events.turnDone();
    speak(e, "On it.");
    await tick(0);
    expect(prompts(e)).toEqual([]);
    expect(voiced(posts).slice(1)).toEqual(["On it."]);
    expect(play).toHaveBeenCalledTimes(1);
    call.end();
    await tick(1_100);
    expect(ended(posts)[0].stats.repeats).toBe(1);
  });

  it.each([
    ["Nothing has failed so far.", "Nothing has failed so far, except the login test."],
    ["It's done, except the tests.", "It's done."],
    ["3 of the tests passed.", "4 of the tests passed."],
    ["The fix is not merged yet.", "The fix is merged."],
    ["The change is -5%.", "The change is 5%."],
  ])("a new fact that only looks like the last line is still said: %s -> %s", async (first, second) => {
    const { audio, engine, posts, tick } = await live();
    const play = vi.spyOn(audio, "play");
    engine().events.heard("How is it going?");
    speak(engine(), first);
    speak(engine(), second);
    await tick(0);
    expect(voiced(posts)).toEqual([first, second]);
    expect(play).toHaveBeenCalledTimes(2);
  });

  it("asked again, he hears the same answer again, even when his words arrive after the voice starts", async () => {
    const { audio, engine, posts, tick } = await live();
    const e = engine();
    const play = vi.spyOn(audio, "play");
    e.events.heard("Is it done?");
    speak(e, "Not yet.");
    e.events.heard("Is it done?");
    speak(e, "Not yet.");
    e.events.answering();
    e.events.audio(new Int16Array([1]));
    e.events.heard("Sorry, is it done?");
    e.events.said("Not yet.");
    e.events.turnDone();
    await tick(0);
    expect(voiced(posts)).toEqual(["Not yet.", "Not yet.", "Not yet."]);
    expect(play).toHaveBeenCalledTimes(3);
  });

  it("a line cut off by noise is said again in full", async () => {
    const { audio, engine, posts, tick } = await live();
    const e = engine();
    const play = vi.spyOn(audio, "play");
    e.events.heard("Is it done?");
    e.events.answering();
    e.events.audio(new Int16Array([1]));
    e.events.said("Not yet, the tests are");
    e.events.interrupted();
    speak(e, "Not yet, the tests are");
    await tick(0);
    expect(voiced(posts)).toEqual(["Not yet, the tests are", "Not yet, the tests are"]);
    expect(play).toHaveBeenCalledTimes(2);
  });

  it.each(["hangs up", "cuts in"])("a repeat still held back when he %s is never played or kept", async (how) => {
    const { audio, call, engine, posts, tick } = await live();
    const e = engine();
    e.events.heard("Is it done?");
    speak(e, "Not yet.");
    const play = vi.spyOn(audio, "play");
    e.events.answering();
    e.events.audio(new Int16Array([1]));
    e.events.said("Not yet.");
    if (how === "cuts in") e.events.interrupted();
    call.end();
    await tick(1_100);
    expect(voiced(posts)).toEqual(["Not yet."]);
    expect(play).not.toHaveBeenCalled();
  });

  it("an answer to words that landed after it started is still the last line, so its repeat is dropped", async () => {
    const { audio, engine, posts, tick } = await live();
    const e = engine();
    const play = vi.spyOn(audio, "play");
    e.events.answering();
    e.events.audio(new Int16Array([1]));
    e.events.heard("Is it done?");
    e.events.said("Not yet.");
    e.events.turnDone();
    speak(e, "Not yet.");
    await tick(0);
    expect(voiced(posts)).toEqual(["Not yet."]);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("a shorter line held until its turn ended still shows as the caption", async () => {
    const { call, engine } = await live();
    engine().events.heard("How is it going?");
    speak(engine(), "It's done, except the tests.");
    speak(engine(), "It's done.");
    expect(call.state().caption).toMatchObject({ who: "voice", text: "It's done." });
  });

  it("a line that starts like a word of the last one plays at once", async () => {
    const { audio, engine } = await live();
    const e = engine();
    e.events.heard("Is it done?");
    speak(e, "Not yet.");
    const play = vi.spyOn(audio, "play");
    e.events.answering();
    e.events.audio(new Int16Array([1]));
    e.events.said("No, ");
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("a dropped repeat leaves the guard as it was", async () => {
    const { call, engine, posts, tick } = await live();
    const e = engine();
    e.events.heard("Fix the login bug.");
    speak(e, "I'll fix it.");
    await tick(0);
    const fixes = e.texts.length;
    speak(e, "I'll fix it.");
    await tick(0);
    expect(e.texts).toHaveLength(fixes);
    call.end();
    await tick(1_100);
    expect(ended(posts)[0].stats).toMatchObject({ repeats: 1, guard: { nudges: 1, failLines: 0, promise: 1 } });
  });
});
