// The 11-15 calls replayed line by line (c-fe757eee6f68, c-042465e96fb5, c-b2f94ce7575d, c-4d062f54ed1b, c-fef843f09039).
// Silent: a fake engine and a fake audio port, no socket, mic or speaker.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CallLine, LiveVoice } from "../../../shared/live-call";
import type { Message } from "@/state/store-types";
import { LiveCall, type CallAudioPort, type Posted } from "./controller";
import type { LiveEngine, LiveEvents, LiveSession } from "./engine";
import * as guard from "./guard";

class FakeEngine implements LiveEngine {
  events!: LiveEvents;
  session!: LiveSession;
  texts: string[] = [];
  results: Array<{ id: string; result: unknown }> = [];
  connect(session: LiveSession, events: LiveEvents) { this.session = session; this.events = events; }
  sendAudio() {}
  audioPaused() {}
  sendText(text: string) { this.texts.push(text); }
  sendContext() {}
  sendToolResult(ids: string[], _name: string, result: unknown) { for (const id of ids) this.results.push({ id, result }); }
  close() {}
}

type Audio = Omit<CallAudioPort, "playing"> & { playing: boolean; flushed: number; played: number; ducked: boolean; mic(loud: boolean): void; click(): void };

function fakeAudio(): Audio {
  let frame: (pcm: ArrayBuffer) => void = () => {};
  let room: ReturnType<typeof setInterval> | undefined;
  return {
    flushed: 0,
    played: 0,
    playing: false,
    ducked: false,
    // A live mic sends room noise all along; without it the call reads as stalled.
    async capture(onFrame) { frame = onFrame; room ??= setInterval(() => frame(new Int16Array(640).fill(20).buffer), 1_000); },
    stopMic() {},
    async heal() { return true; },
    play() { this.played += 1; },
    flush() { this.flushed += 1; this.playing = false; },
    duck(on: boolean) { this.ducked = on; },
    close() { clearInterval(room); },
    boop() {},
    heardShare: () => 0.5,
    micLevel: () => 0.2,
    onIdle: () => {},
    onStart: () => {},
    mic(loud) { frame(new Int16Array(640).fill(loud ? 6_000 : 20).buffer); },
    click() { const pcm = new Int16Array(640).fill(20); pcm.fill(1_500, 300, 324); frame(pcm.buffer); },
  };
}

const CALL = "c-042465e96fb5";
const ACCEPTED: Posted = { status: 202, data: { ok: true } };
const pcm = () => new Int16Array(480);
const flush = () => vi.isFakeTimers() ? vi.advanceTimersByTimeAsync(0) : new Promise((resolve) => setTimeout(resolve, 0));

function setup(opts: { botName?: string; voice?: LiveVoice; device?: "phone" | "desktop"; messages?: Posted } = {}) {
  const audio = fakeAudio();
  const engines: FakeEngine[] = [];
  const posts: Array<{ path: string; body: any }> = [];
  const call = new LiveCall({
    botId: "b1",
    botName: opts.botName ?? "Wink",
    device: opts.device ?? "desktop",
    engine: () => { const engine = new FakeEngine(); engines.push(engine); return engine; },
    audio,
    now: () => Date.now(),
    post: async (path, body) => {
      posts.push({ path, body });
      if (path.endsWith("/messages")) return opts.messages ?? ACCEPTED;
      if (path.endsWith("/call/token")) return { status: 200, data: { callId: CALL, url: "wss://x", token: "t", model: "m", voice: opts.voice ?? "Aoede" } };
      return { status: 200, data: {} };
    },
  });
  return { call, audio, engines, posts, engine: () => engines.at(-1)! };
}

/** Connected and past the hello. */
async function live(opts: Parameters<typeof setup>[0] = {}) {
  const s = setup(opts);
  await s.call.start();
  s.engine().events.ready();
  s.engine().events.answering();
  s.engine().events.said("Hey.");
  s.engine().events.turnDone();
  await vi.advanceTimersByTimeAsync(5_000);
  s.engine().texts.length = 0;
  return s;
}

const fixes = (engine: FakeEngine) => engine.texts.filter((text) => text.startsWith("[Wink]"));
const sentToBot = (posts: Array<{ path: string; body: any }>) => posts.filter((p) => p.path === "/api/bots/b1/messages").map((p) => p.body.text as string);
const linesOf = (posts: Array<{ path: string; body: any }>) => posts.filter((p) => p.path.endsWith("/call/lines")).flatMap((p) => p.body.lines.map((line: CallLine) => `${line.who}: ${line.text}`));
/** The voice speaks a turn: audio first, then its words, as Google sends them. */
const speak = (engine: FakeEngine, said: string, done = true) => {
  engine.events.answering();
  engine.events.audio(pcm());
  engine.events.said(said);
  if (done) engine.events.turnDone();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("crypto", { randomUUID: () => "send-1" });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("1 language lock", () => {
  it("12:24 \"¿Qué?\" then \"Hola, aquí estoy.\": the Spanish never plays, and the voice asks again in English", async () => {
    const { audio, engine, posts } = await live();
    engine().events.heard("¿Qué?");
    speak(engine(), "Hola, aquí estoy.");
    expect(audio.played).toBe(0);
    expect(linesOf(posts)).not.toContain("voice: Hola, aquí estoy.");
    await vi.advanceTimersByTimeAsync(0);
    expect(fixes(engine())).toEqual([expect.stringMatching(/English.*say (?:it|that) again/)]);
  });

  it("a turn that turns Spanish midway is cut at once, after a clear English line", async () => {
    const { audio, engine } = await live();
    engine().events.heard("Hey, can you hear me?");
    engine().events.answering();
    engine().events.audio(pcm());
    expect(audio.played).toBe(1);
    engine().events.said("Hola,");
    expect(audio.flushed).toBe(1);
    engine().events.audio(pcm());
    engine().events.said(" aquí estoy.");
    engine().events.turnDone();
    expect(audio.played).toBe(1);
    expect(fixes(engine())).toHaveLength(1);
  });

  it("English and Korean are his to mix; Spanish and Japanese are a mis-hear", () => {
    const offLanguage = (guard as unknown as { offLanguage: (text: string) => boolean }).offLanguage;
    expect(offLanguage("Hey, can you hear me?")).toBe(false);
    expect(offLanguage("이거 고쳐줘")).toBe(false);
    expect(offLanguage("PR 1645 머지됐어.")).toBe(false);
    expect(offLanguage("¿Qué?")).toBe(true);
    expect(offLanguage("Hola, aquí estoy.")).toBe(true);
    expect(offLanguage("もしもし")).toBe(true);
  });
});

describe("2 one voice for the whole call", () => {
  it("the first session and a resumed one name the same voice, and only the engine's audio plays", async () => {
    const { audio, engines } = await live({ voice: "Erinome" });
    engines[0]!.events.resumable("h1");
    engines[0]!.events.goAway();
    await flush();
    engines[1]!.events.ready();
    engines[1]!.events.heard("Can you hear me?");
    speak(engines[1]!, "Yes, I can.");
    expect(engines.map((engine) => engine.session.voice)).toEqual(["Erinome", "Erinome"]);
    expect(engines[1]!.session.handle).toBe("h1");
    expect(audio.played).toBe(1);
  });
});

describe("3 a mis-hear is never an order", () => {
  it("an offer built on a line in another language is not sent; the voice confirms first", async () => {
    const { engine, posts } = await live();
    engine().events.heard("¿Qué?");
    engine().events.answering();
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Check what is going on." } }]);
    expect(sentToBot(posts)).toEqual([]);
    expect(engine().results).toEqual([{ id: "t1", result: expect.stringMatching(/^not sent: .*mis-?hear.*say (?:it|that) again/) }]);
  });

  it("12:26 a lone \"different\" left when he hangs up is not sent as his message", async () => {
    const { call, engine, posts } = await live();
    engine().events.heard("different");
    speak(engine(), "Could you clarify which sign you want to remove and what kind of greetin", false);
    call.end();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sentToBot(posts)).toEqual([]);
  });

  it("12:38 a trailing \"Okay, I'm\" is not sent on hang-up, but a whole question still is", async () => {
    const { call, engine, posts } = await live({ device: "phone" });
    engine().events.heard("Why is there a delay?");
    engine().events.answering();
    engine().events.toolCall([{ id: "t1", name: "ask", args: { question: "Why is there a delay?" } }]);
    await flush();
    speak(engine(), "I'm right here and ready whenever you're ready to jump back in.");
    engine().events.heard("Okay, I'm");
    speak(engine(), "It's fantastic if you love intricate, puzzle-like sci-fi", false);
    call.end();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sentToBot(posts)).toEqual(["Why is there a delay?"]);
  });
});

describe("4 one ask per question", () => {
  const card: Message = { id: "q1", role: "bot", kind: "options", at: Date.parse("2026-11-15T03:25:44.623Z"), card: { title: "Your bot has a question", subtitle: "On the call I heard \"remove the connection sign and add a greeting design to the board.\" Which sign, and what greeting design?", options: [], askUser: true, staysOpen: true } } as unknown as Message;
  const reply: Message = { id: "r1", role: "bot", kind: "text", at: Date.parse("2026-11-15T03:25:44.584Z"), text: "**No.** The phone icon only shows on what's said out loud on the call.\n\n**One question on the card:** on the call I heard \"remove the connection sign and add a greeting design to the board\", but I'm not sure which sign or greeting you meant." } as Message;
  const asked: Message = { id: "u1", role: "user", kind: "text", at: Date.parse("2026-11-15T03:25:00.986Z"), text: "Does the phone icon above you appear when I'm messaging you during the call?", call: { id: CALL, ask: true }, sendId: "send-1" } as Message;

  async function readOut() {
    vi.setSystemTime(Date.parse("2026-11-15T03:23:30Z"));
    const s = await live();
    s.call.observe({ busy: false, messages: [asked, reply, card] });
    await vi.advanceTimersByTimeAsync(0);
    // 12:25:50, the card: ask number one.
    expect(s.engine().texts).toEqual([expect.stringContaining(" asks: On the call I heard")]);
    speak(s.engine(), "Which sign did you mean to remove, and what kind of greeting design do you want for the board?");
    await vi.advanceTimersByTimeAsync(2_000);
    return s;
  }

  it("12:26:02 the reply read out after its card is told the question was already asked", async () => {
    const { engine } = await readOut();
    const relay = engine().texts.find((text) => text.includes(" replied: "));
    expect(relay).toMatch(/already (?:read out|asked).*(?:never|don'?t|do not) ask it again/i);
  });

  it("12:26:08 after his answer, a turn that asks the same question again is dropped unheard", async () => {
    const { audio, engine, posts } = await readOut();
    speak(engine(), "Quick update: the phone icon only shows for spoken words.");
    await vi.advanceTimersByTimeAsync(2_000);
    const before = audio.played;
    engine().events.heard("The one under the call, and just a hi.");
    speak(engine(), "Could you clarify which sign you want to remove and what kind of greeting design?");
    expect(audio.played).toBe(before);
    expect(linesOf(posts)).not.toContain("voice: Could you clarify which sign you want to remove and what kind of greeting design?");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fixes(engine()).at(-1)).toMatch(/already asked/i);
  });

  it("a plain answer after his reply still plays at once", async () => {
    const { audio, engine } = await readOut();
    const before = audio.played;
    engine().events.heard("The one under the call.");
    engine().events.answering();
    engine().events.audio(pcm());
    engine().events.said("Got it, the connecting sign.");
    expect(audio.played).toBe(before + 1);
  });
});

describe("5 a soft hello", () => {
  it("a click while it connects still gets the hello at once, one calm word, no job recap", async () => {
    const { call, audio, engine } = setup();
    const started = call.start();
    audio.mic(false);
    audio.click();
    await started;
    engine().events.ready();
    expect(engine().texts).toHaveLength(1);
    const hello = engine().texts[0]!;
    expect(hello).toMatch(/"Hey\."/);
    expect(hello).not.toMatch(/job|busy|\?/i);
  });

  it("is skipped when he is already talking as it connects", async () => {
    const { call, audio, engine } = setup();
    const started = call.start();
    for (let i = 0; i < 6; i += 1) audio.mic(true);
    await started;
    engine().events.ready();
    engine().events.heard("Hey, can you hear me?");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(engine().texts).toEqual([]);
  });
});

describe("6 the first phone call is not dead", () => {
  it("12:35 a thumb on the glass while it connects does not cost the hello", async () => {
    const { call, audio, engine } = setup({ device: "phone", botName: "Rando" });
    const started = call.start();
    audio.click();
    audio.mic(false);
    await started;
    engine().events.ready();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(engine().texts.filter((text) => text.includes("The call just started"))).toHaveLength(1);
  });
});

describe("7 barge-in on the phone", () => {
  it("12:38:42 he talks over a line the voice finished sending: it stops at his first words", async () => {
    const { audio, engine, posts } = await live({ device: "phone", botName: "Rando" });
    engine().events.heard("Is Primer good?");
    speak(engine(), "It's excellent if you like complex time travel movies that really make you think and piece things together.");
    audio.playing = true;
    engine().events.heard("Hey, wait a minute,");
    expect(audio.flushed).toBe(1);
    expect(linesOf(posts).at(-1)).toMatch(/^voice: It's excellent/);
  });

  it("a barge-in with no words yet ducks the voice at once, and his words then stop it", async () => {
    const { audio, engine } = await live({ device: "phone" });
    engine().events.heard("Is Primer good?");
    speak(engine(), "It's excellent if you like complex time travel", false);
    audio.playing = true;
    engine().events.interrupted();
    expect(audio.ducked).toBe(true);
    expect(audio.flushed).toBe(0);
    engine().events.heard("Wait,");
    expect(audio.flushed).toBe(1);
  });

  it("the voice's own words coming back through the speaker never cut it and are not his line", async () => {
    const { call, audio, engine, posts } = await live({ device: "phone" });
    engine().events.heard("Is Primer good?");
    speak(engine(), "It's excellent if you like complex time travel movies", false);
    audio.playing = true;
    engine().events.interrupted();
    engine().events.heard("excellent if you like complex");
    expect(audio.flushed).toBe(0);
    expect(audio.ducked).toBe(false);
    engine().events.turnDone();
    engine().events.answering();
    engine().events.turnDone();
    call.end();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(linesOf(posts)).not.toContain("user: excellent if you like complex");
    expect(sentToBot(posts).join(" ")).not.toContain("excellent");
  });
});

describe("8 no fake action", () => {
  it("12:35:21 \"Let me check your watch history\" after only an ask went out gets a correction naming what was asked", async () => {
    const { engine } = await live({ device: "phone", botName: "Rando" });
    engine().events.heard("Hello.");
    engine().events.answering();
    engine().events.toolCall([{ id: "t1", name: "ask", args: { question: "Did I finish watching paradise" } }]);
    await flush();
    engine().events.turnDone();
    speak(engine(), "Let me check your watch history for Paradise while I think of some new sci-fi and thriller shows for you.");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fixes(engine()).at(-1)).toMatch(/only thing being looked into is "Did I finish watching paradise"/);
  });

  it("a line that says what was asked is left alone", async () => {
    const { engine } = await live({ device: "phone", botName: "Rando" });
    engine().events.heard("Did I finish Paradise?");
    engine().events.answering();
    engine().events.toolCall([{ id: "t1", name: "ask", args: { question: "Did I finish watching Paradise?" } }]);
    await flush();
    engine().events.turnDone();
    speak(engine(), "Let me check whether you finished Paradise.");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fixes(engine())).toEqual([]);
  });
});

describe("review threads", () => {
  const shipCard = (options: string[] = []): Message => ({ id: "q2", role: "bot", kind: "options", at: Date.now(), card: { title: "Your bot has a question", subtitle: "Ship it when?", options, askUser: true } }) as unknown as Message;

  async function cardRead(options: string[] = []) {
    const s = await live();
    s.call.observe({ busy: false, messages: [shipCard(options)] });
    await vi.advanceTimersByTimeAsync(0);
    speak(s.engine(), "Ship it when?");
    await vi.advanceTimersByTimeAsync(2_000);
    return s;
  }

  it("P1 a never mind still takes back the order before it at hang-up", async () => {
    const { call, engine, posts } = await live();
    engine().events.heard("Delete the old branches.");
    engine().events.answering();
    engine().events.heard("never mind");
    call.end();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sentToBot(posts)).toEqual([]);
  });

  it("echo split across chunks is dropped whole", async () => {
    const { call, audio, engine, posts } = await live({ device: "phone" });
    engine().events.heard("Is Primer good?");
    speak(engine(), "It's excellent if you like complex time travel movies", false);
    audio.playing = true;
    engine().events.heard("excellent if you");
    engine().events.heard(" like complex");
    expect(audio.flushed).toBe(0);
    engine().events.turnDone();
    call.end();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(linesOf(posts).filter((line) => line.startsWith("user: ") && line.includes("complex"))).toEqual([]);
  });

  it("a hello does not close the card's question, so asking it again still plays", async () => {
    const { audio, engine } = await cardRead();
    engine().events.heard("Hi, Jennifer.");
    const before = audio.played;
    speak(engine(), "When should I ship it?");
    expect(audio.played).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fixes(engine()).filter((text) => /already asked/.test(text))).toEqual([]);
  });

  it("a one-word answer to a free-text card is its answer", async () => {
    const { engine, posts } = await cardRead();
    engine().events.heard("Friday");
    engine().events.answering();
    await vi.advanceTimersByTimeAsync(0);
    expect(sentToBot(posts)).toEqual(["Re: “Ship it when?”\nFriday"]);
  });

  it("a product name is not another language", () => {
    expect(guard.offLanguage("Why is Bonjour discovery not working?")).toBe(false);
    expect(guard.offLanguage("Hola, aquí estoy.")).toBe(true);
    expect(guard.offLanguage("¿Qué?")).toBe(true);
  });

  it("a card readout dropped unheard is read again, and is not answered meanwhile", async () => {
    const { call, engine, posts } = await live();
    call.observe({ busy: false, messages: [shipCard(["Today", "Tomorrow"])] });
    await vi.advanceTimersByTimeAsync(0);
    speak(engine(), "Hola, la pregunta es cuándo.");
    await vi.advanceTimersByTimeAsync(2_000);
    engine().events.heard("Today.");
    engine().events.answering();
    await vi.advanceTimersByTimeAsync(0);
    expect(sentToBot(posts)).toEqual([]);
  });

  it("a yes offer after his answer is a new question, not a re-ask", async () => {
    const { audio, engine } = await live();
    engine().events.heard("Delete some files.");
    speak(engine(), "Which files should I delete?");
    engine().events.heard("The old logs.");
    const before = audio.played;
    engine().events.answering();
    engine().events.audio(pcm());
    engine().events.toolCall([{ id: "p1", name: "propose_work", args: { order: "Delete the old log files." } }]);
    engine().events.said("Would you like me to delete the old log files?");
    engine().events.turnDone();
    expect(audio.played).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fixes(engine()).filter((text) => /already asked/.test(text))).toEqual([]);
  });

  it("asked to repeat a question he answered, the voice may say it again", async () => {
    const { audio, engine } = await live();
    engine().events.heard("Make a branch for it.");
    speak(engine(), "Which branch should I use?");
    engine().events.heard("Main.");
    speak(engine(), "Got it, main.");
    engine().events.heard("Repeat the question.");
    const before = audio.played;
    speak(engine(), "Which branch should I use?");
    expect(audio.played).toBe(before + 1);
  });

  it("a failed ask is not what is being looked into", async () => {
    const { engine } = await live({ device: "phone", botName: "Rando", messages: { status: 403, data: { error: "forbidden" } } });
    engine().events.heard("Did I finish Paradise?");
    engine().events.answering();
    engine().events.toolCall([{ id: "t1", name: "ask", args: { question: "Did I finish watching Paradise?" } }]);
    await flush();
    engine().events.turnDone();
    speak(engine(), "Let me check your watch history.");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fixes(engine()).filter((text) => /being looked into/.test(text))).toEqual([]);
  });

  it("the answer quoted in the re-ask fix is one short sentence", async () => {
    const { engine } = await live();
    engine().events.heard("Make a branch for it.");
    speak(engine(), "Which branch should I use?");
    engine().events.heard("Main, because the release branch is frozen until Friday and nobody should touch it at all this week. Also tell the team.");
    speak(engine(), "Which branch should I use?");
    await vi.advanceTimersByTimeAsync(2_000);
    const quoted = fixes(engine()).find((text) => /already asked/.test(text))?.match(/answered "([^"]*)"/)?.[1] ?? "";
    expect(quoted.length).toBeGreaterThan(0);
    expect(quoted.length).toBeLessThanOrEqual(80);
    expect(quoted).not.toContain("tell the team");
  });

  it("a re-ask streamed word by word is dropped like a whole one", async () => {
    const { audio, engine, posts } = await live();
    engine().events.heard("Make a branch for it.");
    speak(engine(), "Which branch should I use?");
    engine().events.heard("Main.");
    const before = audio.played;
    engine().events.answering();
    engine().events.audio(pcm());
    for (const word of ["Which ", "branch ", "should ", "I ", "use?"]) engine().events.said(word);
    engine().events.turnDone();
    expect(audio.played).toBe(before);
    expect(linesOf(posts).filter((line) => line === "voice: Which branch should I use?")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fixes(engine()).at(-1)).toMatch(/already asked/);
  });
});
