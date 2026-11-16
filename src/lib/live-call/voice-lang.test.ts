// The 11-15 and 11-16 calls replayed line by line (c-fe757eee6f68, c-042465e96fb5, c-b2f94ce7575d, c-4d062f54ed1b, c-fef843f09039, c-21351ca21949).
// Silent: a fake engine and a fake audio port, no socket, mic or speaker.
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { liveVoiceNames, type CallLine, type LiveVoice } from "../../../shared/live-call";
import type { Message } from "@/state/store-types";
import { LiveCall, type CallAudioPort, type Posted } from "./controller";
import type { LiveEngine, LiveEvents, LiveSession } from "./engine";
import { route } from "./gemini";
import * as guard from "./guard";

class FakeEngine implements LiveEngine {
  events!: LiveEvents;
  session!: LiveSession;
  texts: string[] = [];
  contexts: string[] = [];
  results: Array<{ id: string; result: unknown }> = [];
  connect(session: LiveSession, events: LiveEvents) { this.session = session; this.events = events; }
  sendAudio() {}
  audioPaused() {}
  sendText(text: string) { this.texts.push(text); }
  sendContext(text: string) { this.contexts.push(text); }
  sendToolResult(ids: string[], _name: string, result: unknown) { for (const id of ids) this.results.push({ id, result }); }
  close() {}
}

type Audio = Omit<CallAudioPort, "playing"> & { playing: boolean; flushed: number; played: number; mic(loud: boolean): void; click(): void };

function fakeAudio(): Audio {
  let frame: (pcm: ArrayBuffer) => void = () => {};
  let room: ReturnType<typeof setInterval> | undefined;
  return {
    flushed: 0,
    played: 0,
    playing: false,
    // A live mic sends room noise all along; without it the call reads as stalled.
    async capture(onFrame) { frame = onFrame; room ??= setInterval(() => frame(new Int16Array(640).fill(20).buffer), 1_000); },
    stopMic() {},
    async heal() { return true; },
    play() { this.played += 1; },
    endTurn() {},
    tune() {},
    flush() { this.flushed += 1; this.playing = false; },
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

  it("an echo that trips barge-in cuts the voice, and its words coming back are not his line", async () => {
    const { call, audio, engine, posts } = await live({ device: "phone" });
    engine().events.heard("Is Primer good?");
    speak(engine(), "It's excellent if you like complex time travel movies", false);
    audio.playing = true;
    engine().events.interrupted();
    expect(audio.flushed).toBe(1);
    engine().events.heard("excellent if you like complex");
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

describe("late review threads", () => {
  it("a question with a new number is not a re-ask", () => {
    expect(guard.reasks("Should the timeout be 60 seconds?", ["Should the timeout be 30 seconds?"], true)).toBe("no");
    expect(guard.reasks("Should the timeout be 30 seconds?", ["Should the timeout be 30 seconds?"], true)).toBe("yes");
  });

  it("a short lookup with no end mark survives hanging up", async () => {
    expect(guard.misheard("Search cats")).toBe(false);
    const { call, engine, posts } = await live();
    engine().events.heard("Search cats");
    engine().events.answering();
    call.end();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sentToBot(posts)).toEqual(["Search cats"]);
  });

  it("a numeric follow-up after his answer still plays", async () => {
    const { audio, engine } = await live();
    engine().events.heard("Raise the timeout.");
    speak(engine(), "Should the timeout be 30 seconds?");
    engine().events.heard("No, longer.");
    const before = audio.played;
    speak(engine(), "Should the timeout be 60 seconds?");
    expect(audio.played).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fixes(engine()).filter((text) => /already asked/.test(text))).toEqual([]);
  });

  it("an order he tapped yes on is what is being done, beside the ask", async () => {
    const { call, engine, posts } = await live();
    engine().events.heard("What version is installed? And restart the server.");
    engine().events.answering();
    engine().events.toolCall([{ id: "t1", name: "ask", args: { question: "What version is installed?" } }]);
    engine().events.toolCall([{ id: "p1", name: "propose_work", args: { order: "Restart the server." } }]);
    await flush();
    engine().events.turnDone();
    await call.answer(true);
    expect(sentToBot(posts)).toEqual(["What version is installed?", "Restart the server."]);
    speak(engine(), "I'm restarting the server now.");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fixes(engine()).filter((text) => /being looked into/.test(text))).toEqual([]);
  });

  it("the offer's own words back through the speaker do not say yes to it", async () => {
    const { audio, engine, posts } = await live({ device: "phone" });
    engine().events.heard("Deploy the build.");
    engine().events.answering();
    engine().events.audio(pcm());
    engine().events.toolCall([{ id: "p1", name: "propose_work", args: { order: "Deploy the build." } }]);
    engine().events.said("Would you like me to go for it?");
    audio.playing = true;
    engine().events.heard("Go for it.");
    engine().events.turnDone();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sentToBot(posts)).toEqual([]);
  });
});

// The 11-15 audits' probes (FINDINGS-FABLE F0-F2, FINDINGS-SOL S06) as assertions.
describe("9 quiet means quiet", () => {
  const QUIET = [
    "Stay quiet.", "Be quiet.", "Wink, stay quiet for a minute.", "Okay stay quiet", "Shh.",
    "Stay quiet for a few minutes.", "Stay quiet for five minutes.", "Stay quiet, I'm talking to someone.", "Stay quiet while I talk to my friend.", "Be quiet, I need to talk to my wife.",
    "Can you stay quiet for a bit?", "Don't say anything.", "Don't talk.", "Don't respond.", "Stop responding.", "Mute yourself.", "Give me a minute.", "Hold on, I'm talking to someone else.", "Not talking to you.", "I'm not talking to you.",
    "Stay quite.", "Be quite.", "Stay quiet okay?", "Just listen.", "Stay silent.", "Keep it down.", "Pause.",
    "조용히 해.", "잠깐 조용히 있어 봐.", "조용히 좀 해줘.", "잠깐만 조용히 해봐, 나 얘기 중이야.", "말하지 말고 있어.", "가만히 있어.", "아무 말도 하지 마.", "대답하지 마.", "잠깐 기다려, 친구랑 얘기 좀 할게.",
    "Stay quiet for a few minutes, I'm talking to my friend.",
  ];
  // [shown voice, bot name, line]
  const SIDE: Array<[LiveVoice, string, string]> = [
    ["Aoede", "Wink", "Hey, did you eat yet?"], ["Aoede", "Wink", "헤이 뭐해"], ["Aoede", "Wink", "Did you see him wink at me?"], ["Aoede", "Wink", "I'm on a call with Wink."],
    ["Aoede", "Wink", "Jenny said she's coming."], ["Aoede", "Wink", "Jennifer is late again."], ["Aoede", "Wink", "젠 어디 갔어?"], ["Alnilam", "Wink", "Eddie, dinner's ready."],
    ["Alnilam", "Wink", "에디야 밥 먹어"], ["Alnilam", "Wink", "Eddy can you help me?"], ["Erinome", "Wink", "I love that Adele song."], ["Aoede", "Zen", "That place is so zen."],
    ["Aoede", "Wink", "I told Peter to say hey when he arrives."], ["Aoede", "Wink", "Jennings is meeting us downstairs."], ["Aoede", "Wink", "피터야, hey라고 말해 줘."], ["Aoede", "Wink", "제니퍼, 피터가 곧 온대."], ["Aoede", "Wink", "Hola, hey, ¿cómo estás?"],
  ];
  const WAKE: Array<[LiveVoice, string]> = [["Aoede", "Wink?"], ["Aoede", "Hey Wink."], ["Aoede", "Jenn, are you there?"], ["Aoede", "Jennifer, you can talk now."], ["Alnilam", "Eddie?"], ["Alnilam", "에디야"], ["Erinome", "아델, 이제 말해도 돼."]];
  const names = (voice: LiveVoice) => liveVoiceNames(voice);

  it("every quiet ask in the audits hushes, extra words and all", () => {
    expect(QUIET.filter((line) => !guard.asksForQuiet(line, "Wink", ["Jenn"]))).toEqual([]);
  });

  it("side talk with a hey, a name or its own name in it never wakes it; its name said to it does", () => {
    expect(SIDE.filter(([voice, bot, line]) => guard.callsVoice(line, bot, names(voice)))).toEqual([]);
    expect(WAKE.filter(([voice, line]) => !guard.callsVoice(line, "Wink", names(voice)))).toEqual([]);
  });

  it.each(["Stay quiet, I'm talking to someone.", "Stay quiet for a few minutes, I'm talking to my friend.", "잠깐만 조용히 해봐, 나 얘기 중이야."])("after \"%s\" side talk word by word never plays, offers or wakes it", async (hush) => {
    const { call, audio, engine, posts } = await live({ voice: "Alnilam", botName: "Wink" });
    engine().events.heard(hush);
    speak(engine(), "Okay, I'll stay quiet.");
    expect(call.state().hushed).toBe(true);
    const played = audio.played;
    for (const [, , line] of SIDE) {
      for (const word of line.split(/(?<= )/)) engine().events.heard(word);
      engine().events.answering();
      engine().events.audio(pcm());
      engine().events.audio(pcm());
      engine().events.said("네, 맛있게 드세요!");
      engine().events.toolCall([{ id: `t-${line}`, name: "propose_work", args: { order: "Order kimchi stew for dinner" } }]);
      engine().events.turnDone();
      await vi.advanceTimersByTimeAsync(2_000);
    }
    expect({ hushed: call.state().hushed, played: audio.played - played, pending: call.state().pending, sent: sentToBot(posts) }).toEqual({ hushed: true, played: 0, pending: undefined, sent: [] });
    engine().events.heard("Eddie?");
    speak(engine(), "I'm here.", false);
    expect({ hushed: call.state().hushed, played: audio.played - played }).toEqual({ hushed: undefined, played: 1 });
  });

  it("the reply in flight when he says stay quiet never plays after", async () => {
    const { call, audio, engine } = await live();
    engine().events.heard("What's on my list today?");
    speak(engine(), "You have three things today. First, ", false);
    audio.playing = true;
    engine().events.heard("Stay quiet, I'm talking to someone.");
    engine().events.interrupted();
    await vi.advanceTimersByTimeAsync(1_500);
    const played = audio.played;
    speak(engine(), "Sure, I'll be quiet.");
    expect({ hushed: call.state().hushed, played: audio.played - played }).toEqual({ hushed: true, played: 0 });
  });

  it.each(["name", "tap"] as const)("a wake by %s mid-turn drops the turn already in flight; the next one plays", async (by) => {
    const { call, audio, engine } = await live({ voice: "Alnilam" });
    engine().events.heard("Stay quiet.");
    speak(engine(), "Okay.");
    engine().events.heard("So where should we go tonight?");
    engine().events.answering();
    engine().events.audio(pcm());
    if (by === "tap") call.wake();
    else {
      engine().events.heard("Eddie?");
      await vi.advanceTimersByTimeAsync(1_500);
    }
    expect(call.state().hushed).toBeUndefined();
    engine().events.audio(pcm());
    engine().events.said("How about the new Italian place downtown?");
    engine().events.turnDone();
    expect(audio.played).toBe(0);
    speak(engine(), "I'm here.");
    expect(audio.played).toBe(1);
  });

  it("a barge-in cuts the voice at once and it stays cut: no duck, no coming back up", async () => {
    const { audio, engine, posts } = await live({ device: "phone" });
    engine().events.heard("Tell me about the plan.");
    speak(engine(), "The plan has three parts. First we fix login.", false);
    audio.playing = true;
    engine().events.interrupted();
    expect(audio.flushed).toBe(1);
    await vi.advanceTimersByTimeAsync(1_600);
    expect({ flushed: audio.flushed, played: audio.played }).toEqual({ flushed: 1, played: 1 });
    expect(linesOf(posts).at(-1)).toMatch(/^voice: The plan.*…$/);
  });

  it("talk-over is a cut, never a duck: nothing turns the voice down to bring it back up", () => {
    for (const file of readdirSync(new URL(".", import.meta.url)).filter((name) => /(?<!\.test)\.ts$/.test(name)).map((name) => `./${name}`)) {
      expect(readFileSync(new URL(file, import.meta.url), "utf8"), `${file}: barge-in must flush() playback, never lower the volume and raise it again`).not.toMatch(/\.volume\s*=|duck/i);
    }
  });

  it("a yes that lands after its tool call was cancelled is acked once, whatever the words", async () => {
    const { engine, posts } = await live();
    engine().events.heard("Fix the login bug on the settings page.");
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Fix the login bug on the settings page" } }]);
    await vi.advanceTimersByTimeAsync(500);
    engine().events.heard("Yes.");
    engine().events.toolCancel(["t1"]);
    engine().events.interrupted();
    await vi.advanceTimersByTimeAsync(3_000);
    speak(engine(), "On it.");
    await vi.advanceTimersByTimeAsync(8_000);
    expect(sentToBot(posts)).toEqual(["Fix the login bug on the settings page"]);
    expect(engine().results).toEqual([]);
    expect(fixes(engine())).toEqual([]);
    expect(engine().contexts.at(-1)).toContain("Already answered aloud. Context only, do not read it out.");
  });
});

describe("S03 words that came with their audio are checked first", () => {
  it("a frame with Spanish words never plays its audio", async () => {
    const { audio, engine } = await live();
    engine().events.heard("Hello again.");
    route({ serverContent: { modelTurn: { parts: [{ inlineData: { data: "AAAA" } }] }, outputTranscription: { text: "Hola, aquí estoy." } } }, engine().events, { answering: false });
    expect(audio.played).toBe(0);
  });

  it("an English frame still plays", async () => {
    const { audio, engine } = await live();
    engine().events.heard("Hello again.");
    route({ serverContent: { modelTurn: { parts: [{ inlineData: { data: "AAAA" } }] }, outputTranscription: { text: "Hi, I'm here." } } }, engine().events, { answering: false });
    expect(audio.played).toBe(1);
  });
});

describe("11-16 call c-21351ca21949, in its own order", () => {
  const HELLO = "Send a hello message in the chat.";
  const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  const offer = (engine: FakeEngine, said: string, order: string, id: string) => {
    engine.events.answering();
    engine.events.audio(pcm());
    engine.events.said(said);
    engine.events.toolCall([{ id, name: "propose_work", args: { order } }]);
    engine.events.turnDone();
  };

  it.each(["the voice answers first", "the result lands first"])("15:00:26 a spoken yes gets one On it, though the other turn comes with no words (%s)", async (order) => {
    const { audio, engine, posts } = await live();
    const e = engine();
    e.events.heard("Can you send me hello on chat?");
    offer(e, "Want me to send a hello message in the chat for you?", HELLO, "p1");
    await tick(5_000);
    e.events.heard("Yes.");
    await tick(1_200);
    if (order === "the result lands first") await tick(10);
    speak(e, "On it.");
    await tick(10);
    expect(e.results).toEqual([{ id: "p1", result: "sent. They already heard you answer: say nothing more." }]);
    const played = audio.played;
    // Google speaks after every tool result and after his yes; one of the two turns had no transcript.
    e.events.answering();
    e.events.audio(pcm());
    e.events.turnDone();
    await tick(5_000);
    expect(audio.played).toBe(played);
    expect(sentToBot(posts)).toEqual([HELLO]);
  });

  it.each(["after the wordless second turn", "with no second turn"])("the answer to his next question plays, though it starts before his words come back (%s)", async (order) => {
    const { audio, engine } = await live();
    const e = engine();
    e.events.heard("Can you send me hello on chat?");
    offer(e, "Want me to send a hello message in the chat for you?", HELLO, "p1");
    await tick(5_000);
    e.events.heard("Yes.");
    await tick(1_200);
    speak(e, "On it.");
    await tick(10);
    if (order === "after the wordless second turn") {
      e.events.answering();
      e.events.audio(pcm());
      e.events.turnDone();
    }
    await tick(5_000);
    const played = audio.played;
    e.events.answering();
    e.events.heard("What's on my list?");
    e.events.audio(pcm());
    e.events.said("You have two things on your list.");
    e.events.turnDone();
    expect(audio.played).toBe(played + 1);
  });

  it("a failed send still speaks after the ack", async () => {
    const { audio, engine } = await live({ messages: { status: 500, data: { error: "down" } } });
    const e = engine();
    e.events.heard("Can you send me hello on chat?");
    offer(e, "Want me to send a hello message in the chat for you?", HELLO, "p1");
    await tick(5_000);
    e.events.heard("Yes.");
    await tick(1_200);
    speak(e, "On it.");
    await tick(3_000);
    expect(e.results).toEqual([{ id: "p1", result: "not confirmed: down" }]);
    const played = audio.played;
    speak(e, "Sorry, that didn't go through.");
    expect(audio.played).toBe(played + 1);
  });

  it("15:00:52 asked to stay quiet in his own words, it stays quiet when he says \"agent\"", async () => {
    const { audio, call, engine } = await live({ voice: "Alnilam" });
    const e = engine();
    e.events.heard("Let me see if you can stay quiet while I talk to my friend.");
    e.events.answering();
    e.events.audio(pcm());
    e.events.said("Understood. I will remain quiet while you speak.");
    e.events.toolCall([{ id: "h1", name: "hush", args: {} }]);
    e.events.turnDone();
    expect(call.state().hushed).toBe(true);
    const played = audio.played;
    e.events.heard("agent");
    await tick(1_500);
    speak(e, "Hey, I'm here. What would you like to do?");
    expect(call.state().hushed).toBe(true);
    expect(audio.played).toBe(played);
    e.events.heard("Eddie?");
    await tick(1_500);
    speak(e, "I'm here.");
    expect(audio.played).toBe(played + 1);
  });

  it.each(["the offer comes with the line", "the offer lands while the line still plays"])("15:01:19 an offer on screen is not asked again, and his yes answers it once (%s)", async (order) => {
    const { audio, call, engine, posts } = await live();
    const e = engine();
    const add = "Add the issue of me speaking when I was supposed to be quiet to the room fixes.";
    e.events.heard("Record that so we can fix it.");
    e.events.answering();
    e.events.audio(pcm());
    e.events.said("I'll add the issue of me speaking when I was supposed to be quiet to the room fixes.");
    if (order === "the offer comes with the line") e.events.toolCall([{ id: "p2", name: "propose_work", args: { order: add } }]);
    audio.playing = true;
    e.events.turnDone();
    if (order !== "the offer comes with the line") e.events.toolCall([{ id: "p2", name: "propose_work", args: { order: add } }]);
    audio.playing = false;
    audio.onIdle();
    await tick(2_000);
    expect(fixes(e).filter((line) => /ask them again|call ask or propose_work/i.test(line))).toEqual([]);
    expect(call.state().pending?.order).toBe(add);
    e.events.heard("Yes.");
    await tick(1_200);
    speak(e, "On it.");
    await tick(10);
    expect(sentToBot(posts)).toEqual([add]);
    expect(call.state().pending).toBeUndefined();
  });

  it("15:01:23 an offer said again in other words replaces the first with no \"replaced\" line under it", async () => {
    const { call, engine } = await live();
    const e = engine();
    e.events.heard("Record that so we can fix it.");
    offer(e, "Want me to add the issue of me speaking when I was supposed to be quiet to the room fixes?", "Add the issue of me speaking when I was supposed to be quiet to the room fixes.", "p2");
    offer(e, "Should I add the issue of me speaking while quiet to the room fixes?", "Add the issue of me speaking while quiet to the room fixes.", "p3");
    expect(call.state().pending?.order).toBe("Add the issue of me speaking while quiet to the room fixes.");
    expect(call.state().notice).toBeUndefined();
  });

  it("15:01:48 a promise while the offer waits says plainly it waits for a yes, never asks again", async () => {
    const { engine } = await live();
    const e = engine();
    const add = "Add the issue of me speaking while quiet to the room fixes.";
    e.events.heard("Record that so we can fix it.");
    offer(e, "Should I add the issue of me speaking while quiet to the room fixes?", add, "p3");
    await tick(5_000);
    e.events.heard("And even though I said yes. The card is still up showing the question for yes or no.");
    speak(e, "I'll add the issue of me speaking while quiet to the room fixes for you now.");
    await tick(0);
    expect(fixes(e)).toEqual([`[Wink] Not done: "${add}" starts only once they say yes, and its question is on their screen. Say that plainly in one short line; don't ask it again or offer it again.`]);
  });
});

describe("15:00:09 a spoken language ask holds for the rest of the call", () => {
  const ASK = "Can you respond back to me in Thai? As if you were the robot.";
  const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  // His words come back as the voice starts its own answer, the English refusal it gave at 15:00:14.
  const askThai = async (e: FakeEngine) => {
    e.events.heard(ASK);
    speak(e, "I can only respond in English for now. Is there anything else?");
    await tick(1_500);
  };

  it("asks in his words name the language; talk about one does not", () => {
    const asks = guard as unknown as { asksForLanguage: (text: string) => string | undefined };
    expect([ASK, "Reply in Thai.", "Speak Thai, please.", "Can you talk to me in Japanese?", "Switch to Spanish.", "태국어로 말해줘.", "일본어로 대답해 줄래?", "Okay, back to English."].map(asks.asksForLanguage))
      .toEqual(["Thai", "Thai", "Thai", "Japanese", "Spanish", "Thai", "Japanese", "English"]);
    expect(["My friend speaks Thai.", "I talked to her in Thai yesterday.", "Is Thai food good?", "Thai", "Fix the Thai translation."].map(asks.asksForLanguage)).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });

  it("after he asks, the voice's Thai plays and his Thai is his, not a mis-hear", async () => {
    const { audio, call, engine, posts } = await live();
    const e = engine();
    await askThai(e);
    expect(audio.played).toBe(0);
    expect(fixes(e).at(-1)).toBe("[Wink] They asked you to speak Thai. From now on in this call speak only Thai, whatever language they use. In Thai, say in a few words that you will.");
    const flushed = audio.flushed;
    speak(e, "ได้เลย ฉันจะพูดภาษาไทย");
    expect([audio.played, audio.flushed]).toEqual([1, flushed]);
    expect(fixes(e).filter((line) => line.startsWith("[Wink] Wrong language"))).toEqual([]);
    e.events.heard("ส่งคำว่าสวัสดีในแชทได้ไหม");
    e.events.answering();
    e.events.toolCall([{ id: "p1", name: "propose_work", args: { order: "ส่งคำว่าสวัสดีในแชท" } }]);
    expect(e.results).toEqual([]);
    expect(call.state().pending?.order).toBe("ส่งคำว่าสวัสดีในแชท");
    expect(sentToBot(posts)).toEqual([]);
  });

  it("another language than the one he asked for is still a mis-hear", async () => {
    const { audio, engine } = await live();
    const e = engine();
    await askThai(e);
    speak(e, "ได้เลย ฉันจะพูดภาษาไทย");
    await tick(1_500);
    const flushed = audio.flushed;
    e.events.heard("What time is it?");
    speak(e, "Привет, я здесь.");
    expect(audio.flushed).toBe(flushed + 1);
    expect(fixes(e).at(-1)).toBe("[Wink] Wrong language: speak only Thai. In Thai, ask them in a few words to say that again.");
  });

  it("in the language he asked for, a whole line with no spaces is his, and a stub is still a mis-hear", () => {
    expect(guard.misheard("デスクトップのフォルダを開いてください。", "Japanese")).toBe(false);
    expect(guard.misheard("デスクトップのフォルダを開いて", "Japanese")).toBe(false);
    expect(guard.misheard("帮我打开桌面文件夹。", "Chinese")).toBe(false);
    expect(guard.misheard("帮我打开桌面文件夹", "Chinese")).toBe(false);
    expect(guard.misheard("เปิดโฟลเดอร์แชทเลย", "Thai")).toBe(false);
    expect(guard.misheard("Открой папку на рабочем столе", "Russian")).toBe(false);
    expect(guard.misheard("デスク", "Japanese")).toBe(true);
    expect(guard.misheard("桌面", "Chinese")).toBe(true);
    expect(guard.misheard("เปิด", "Thai")).toBe(true);
    expect(guard.misheard("different")).toBe(true);
  });

  it.each([
    ["Japanese", "Can you talk to me in Japanese?", "デスクトップのフォルダを開いてください。", "はい。"],
    ["Chinese", "Switch to Chinese.", "帮我打开桌面文件夹。", "好的。"],
    ["Thai", ASK, "เปิดโฟลเดอร์แชทเลย", "ใช่ครับ"],
  ])("in %s, his request goes to the bot on hang-up, and his spoken yes sends the offer", async (_tongue, ask, request, yes) => {
    const first = await live();
    first.engine().events.heard(ask);
    speak(first.engine(), "OK.");
    await tick(1_500);
    first.engine().events.heard(request);
    speak(first.engine(), "OK, opening", false);
    first.call.end();
    await tick(2_000);
    expect(sentToBot(first.posts)).toEqual([expect.stringContaining(request)]);

    const second = await live();
    const e = second.engine();
    e.events.heard(ask);
    speak(e, "OK.");
    await tick(1_500);
    e.events.heard(request);
    e.events.answering();
    e.events.toolCall([{ id: "p1", name: "propose_work", args: { order: request } }]);
    e.events.turnDone();
    await tick(5_000);
    e.events.heard(yes);
    await tick(1_500);
    expect(sentToBot(second.posts)).toEqual([request]);
  });

  it("unasked, Thai is still a mis-hear", async () => {
    const { audio, engine } = await live();
    const e = engine();
    e.events.heard("Can you hear me?");
    speak(e, "ได้ยินค่ะ");
    expect(audio.flushed).toBe(1);
    expect(fixes(e).at(-1)).toBe("[Wink] Wrong language: speak only English. In English, ask them in a few words to say that again.");
  });
});
