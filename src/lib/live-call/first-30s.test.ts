// The first 30 seconds of a live call, as the VOICE-AUDIT repros found them (Fable rows F#, Astra A##).
// Silent: a fake engine and a fake audio port, no socket, mic or speaker.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CallLine, LiveVoice } from "../../../shared/live-call";
import type { Message } from "@/state/store-types";
import { LiveCall, type CallAudioPort, type Posted } from "./controller";
import type { LiveEngine, LiveEvents, LiveSession } from "./engine";
import { asksForQuiet, callsVoice } from "./guard";

type Utterance = { voice: LiveVoice | undefined; text: string };

class FakeEngine implements LiveEngine {
  events!: LiveEvents;
  session!: LiveSession;
  texts: string[] = [];
  contexts: string[] = [];
  results: Array<{ id: string; result: unknown }> = [];
  constructor(private readonly log: Utterance[]) {}
  connect(session: LiveSession, events: LiveEvents) { this.session = session; this.events = events; }
  sendAudio() {}
  audioPaused() {}
  sendText(text: string) {
    this.texts.push(text);
    this.log.push({ voice: this.session.voice, text });
  }
  sendContext(text: string) { this.contexts.push(text); }
  sendToolResult(ids: string[], _name: string, result: unknown) { for (const id of ids) this.results.push({ id, result }); }
  close() {}
}

type Audio = Omit<CallAudioPort, "playing"> & { playing: boolean; flushed: number; played: number; mic(loud: boolean): void };

function fakeAudio(): Audio {
  let frame: (pcm: ArrayBuffer) => void = () => {};
  return {
    flushed: 0,
    played: 0,
    playing: false,
    async capture(onFrame) { frame = onFrame; },
    async heal() { return true; },
    play() { this.played += 1; },
    flush() { this.flushed += 1; },
    close() {},
    boop() {},
    heardShare: () => 0.5,
    micLevel: () => 0.2,
    onIdle: () => {},
    onStart: () => {},
    mic(loud) { frame(new Int16Array(640).fill(loud ? 6_000 : 20).buffer); },
  };
}

const CALL = "c-0123456789ab";
const ACCEPTED: Posted = { status: 202, data: { ok: true } };
const flush = () => vi.isFakeTimers() ? vi.advanceTimersByTimeAsync(0) : new Promise((resolve) => setTimeout(resolve, 0));
/** Time passing with nobody talking. */
const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);

async function started(opts: { botName?: string; responses?: Record<string, Posted>; voice?: LiveVoice; callId?: string } = {}) {
  const audio = fakeAudio();
  const engines: FakeEngine[] = [];
  const said: Utterance[] = [];
  const posts: Array<{ path: string; body: any }> = [];
  const call = new LiveCall({
    botId: "b1",
    botName: opts.botName ?? "Chief of Staff",
    device: "desktop",
    engine: () => { const engine = new FakeEngine(said); engines.push(engine); return engine; },
    audio,
    now: () => 1_000,
    post: async (path, body) => {
      posts.push({ path, body });
      const hit = Object.entries(opts.responses ?? {}).find(([suffix]) => path.endsWith(suffix));
      if (hit) return hit[1];
      if (path.endsWith("/call/token")) return { status: 200, data: { callId: opts.callId ?? CALL, url: "wss://x", token: "t", model: "m", voice: opts.voice ?? "Aoede" } };
      return { status: 200, data: {} };
    },
  });
  await call.start();
  const engine = () => engines.at(-1)!;
  engine().events.ready();
  return { call, audio, engines, engine, posts, said };
}

const botRow = (id: string, text: string, extra: Partial<Message> = {}): Message => ({ id, role: "bot", kind: "text", text, at: 2_000, ...extra }) as Message;
const userRow = (id: string, text: string, extra: Partial<Message> = {}): Message => ({ id, role: "user", kind: "text", text, at: 2_000, ...extra }) as Message;
const orderRow = (id: string, text: string) => userRow(id, text, { call: { id: CALL, order: true } });
/** A worker's report landing in the bot's chat: it wakes the bot, nobody typed it. */
const paneNote = (id: string, nick: string, at = 2_000): Message => ({ id, role: "user", kind: "note", text: `[pane 1a2b3c4d] [${nick} | fix] DONE ${nick} branch=fix/${nick.toLowerCase()} sha=abc1234 dirty=0\nAll green.`, at }) as Message;
const shipCard = (id: string, at = 2_000, extra: Record<string, unknown> = {}) => ({ id, role: "bot", kind: "options", at, card: { title: "Your bot has a question", subtitle: "Is it OK to ship 1.0.263 now?", options: ["Ship it", "Wait"], askUser: true, ...extra } }) as Message;
/** A chat that already has history, like every real one. */
const HISTORY = [userRow("typed", "Ship the picker fix when CI is green.", { at: 10 }), botRow("ack", "On it.", { at: 20 })];

const replies = (engine: FakeEngine) => engine.texts.filter((text) => text.includes(" replied: "));
const readouts = (engine: FakeEngine) => engine.texts.filter((text) => text.includes(" asks: "));
const sentToBot = (posts: Array<{ path: string; body: any }>) => posts.filter((p) => p.path === "/api/bots/b1/messages").map((p) => p.body.text as string);
const linesOf = (posts: Array<{ path: string; body: any }>) => posts.filter((p) => p.path.endsWith("/call/lines")).flatMap((p) => p.body.lines.map((line: CallLine) => line.text));
/** A whole turn: what the person said (if anything), then the voice's answer. */
const turn = (engine: FakeEngine, heard: string, said: string) => {
  if (heard) engine.events.heard(heard);
  engine.events.answering();
  engine.events.said(said);
  engine.events.turnDone();
};
/** The person cuts the voice off; Google sends interrupted then turnComplete, the transcript on its own clock. */
const cutOff = (engine: FakeEngine, audio: Audio, saidSoFar: string) => {
  engine.events.answering();
  engine.events.said(saidSoFar);
  audio.mic(true);
  engine.events.interrupted();
  engine.events.turnDone();
};

beforeEach(() => { vi.stubGlobal("crypto", { randomUUID: () => "send-1" }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("1 no unasked speech", () => {
  it("F2 a reply to a worker's pane note is context, never read into the call", async () => {
    const { call, engine } = await started();
    engine().events.turnDone();
    const rows = [...HISTORY];
    for (const nick of ["PICKER", "MAP", "VIDEO"]) {
      rows.push(paneNote(`note-${nick}`, nick), botRow(`wake-${nick}`, `I'm merging ${nick} now that its worker reported done.`));
      call.observe({ busy: false, messages: [...rows] });
      await flush();
      engine().events.turnDone();
    }
    expect(replies(engine())).toEqual([]);
    expect(engine().contexts.filter((text) => text.includes("I'm merging"))).toHaveLength(3);
  });

  it("A01 a background reply after an old typed message stays context", async () => {
    const { call, engine } = await started();
    engine().events.turnDone();
    call.observe({ busy: false, messages: [userRow("old", "Check yesterday's build", { at: 100 }), paneNote("note", "WORKER", 1_500), botRow("wake", "Worker finished its background job")] });
    await flush();
    expect(replies(engine())).toEqual([]);
  });

  it("a reply to a message typed before the call stays context", async () => {
    const { call, engine } = await started();
    engine().events.turnDone();
    call.observe({ busy: false, messages: [userRow("old", "What broke?", { at: 500 }), botRow("r", "The login token expired.")] });
    await flush();
    expect(replies(engine())).toEqual([]);
  });

  it("a reply to a message typed during the call is still read out", async () => {
    const { call, engine } = await started();
    engine().events.turnDone();
    call.observe({ busy: false, messages: [...HISTORY, userRow("now", "What broke?"), botRow("r", "The login token expired.")] });
    await flush();
    expect(replies(engine())).toEqual(["[Wink] Chief of Staff replied: The login token expired."]);
  });

  it("a worker note while this call's order runs keeps the order's reply, and the bot's next line about the note is context", async () => {
    const { call, engine } = await started({ responses: { "/messages": ACCEPTED } });
    engine().events.turnDone();
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Check the build." } }]);
    await call.answer(true);
    const rows = [...HISTORY, orderRow("o1", "Check the build."), paneNote("n1", "PICKER"), botRow("r1", "The build is green.")];
    call.observe({ busy: false, messages: [...rows] });
    await flush();
    expect(replies(engine())).toEqual(["[Wink] Chief of Staff replied: The build is green."]);
    engine().events.turnDone();
    rows.push(paneNote("n2", "MAP"), botRow("r2", "Merging MAP now."));
    call.observe({ busy: false, messages: [...rows] });
    await flush();
    engine().events.turnDone();
    expect(replies(engine())).toHaveLength(1);
    expect(call.state().status).toBe("listening");
  });
});

describe("2 a quiet gap", () => {
  it("F2 an update never starts in the same breath as the voice's own answer, and goes after 1.5 s of quiet", async () => {
    vi.useFakeTimers();
    const { call, engine } = await started();
    engine().events.turnDone();
    engine().events.heard("If I say be quiet, can you do that?");
    engine().events.answering();
    call.observe({ busy: false, messages: [...HISTORY, userRow("now", "Check CI."), botRow("r", "I'm checking the CI run now.")] });
    await flush();
    engine().events.said("Yes, just say be quiet.");
    engine().events.turnDone();
    expect(replies(engine())).toEqual([]);
    await wait(1_400);
    expect(replies(engine())).toEqual([]);
    await wait(100);
    expect(replies(engine())).toHaveLength(1);
  });

  it("the gap runs from when the voice's audio drains, not its turn end", async () => {
    vi.useFakeTimers();
    const { call, audio, engine } = await started();
    engine().events.turnDone();
    engine().events.answering();
    engine().events.said("Sure.");
    audio.onStart();
    audio.playing = true;
    engine().events.turnDone();
    call.observe({ busy: false, messages: [...HISTORY, userRow("now", "Check CI."), botRow("r", "CI is green.")] });
    await wait(2_000);
    expect(replies(engine())).toEqual([]);
    audio.playing = false;
    audio.onIdle();
    await wait(1_400);
    expect(replies(engine())).toEqual([]);
    await wait(100);
    expect(replies(engine())).toHaveLength(1);
  });

  it("F9 cutting an update off does not start the next one over the person", async () => {
    const { call, audio, engine } = await started();
    engine().events.turnDone();
    call.observe({ busy: false, messages: [...HISTORY, userRow("u1", "Check CI."), botRow("r1", "CI is green."), userRow("u2", "And the build?"), botRow("r2", "The build is still running.")] });
    await flush();
    expect(replies(engine())).toHaveLength(1);
    engine().events.answering();
    engine().events.said("Quick update: CI");
    audio.onStart();
    audio.playing = true;
    audio.mic(true);
    engine().events.interrupted();
    engine().events.turnDone();
    audio.mic(true);
    audio.playing = false;
    audio.onIdle();
    expect(replies(engine())).toHaveLength(1);
  });

  it("after a real cut the next update waits until he has finished and got an answer", async () => {
    vi.useFakeTimers();
    const { call, audio, engine } = await started();
    engine().events.turnDone();
    call.observe({ busy: false, messages: [...HISTORY, userRow("u1", "Check CI."), botRow("r1", "CI is green."), userRow("u2", "And the build?"), botRow("r2", "The build is still running.")] });
    await flush();
    engine().events.answering();
    engine().events.said("Quick update: CI");
    engine().events.heard("Hold on, ");
    engine().events.interrupted();
    engine().events.turnDone();
    await wait(2_000);
    expect(replies(engine())).toHaveLength(1);
    engine().events.heard("what was that about the tests?");
    engine().events.answering();
    await wait(2_000);
    expect(replies(engine())).toHaveLength(1);
    engine().events.said("CI is green, tests too.");
    engine().events.turnDone();
    await wait(1_500);
    expect(replies(engine())).toHaveLength(2);
  });
});

describe("3 question manners", () => {
  it("F3 small talk after the question was read out is not sent to the bot as its answer", async () => {
    const { call, engine, posts } = await started({ responses: { "/messages": ACCEPTED } });
    engine().events.turnDone();
    call.observe({ busy: false, messages: [...HISTORY, shipCard("q1")] });
    turn(engine(), "", "Is it OK to ship 1.0.263 now? Ship it, or wait?");
    engine().events.heard("I was just saying hi to you.");
    engine().events.answering();
    await flush();
    expect(sentToBot(posts)).toEqual([]);
    expect(linesOf(posts)).toContain("I was just saying hi to you.");
  });

  it("A03 a greeting after a spoken card is not sent as its answer, and a later clear answer still is", async () => {
    const { call, engine, posts } = await started({ responses: { "/messages": ACCEPTED } });
    engine().events.turnDone();
    call.observe({ busy: false, messages: [shipCard("q1")] });
    turn(engine(), "", "Is it OK to ship the release?");
    turn(engine(), "Wait, you just turned into a guy.", "Sorry, that was a glitch.");
    await flush();
    expect(sentToBot(posts)).toEqual([]);
    engine().events.heard("Ship it.");
    engine().events.answering();
    await flush();
    expect(sentToBot(posts)).toHaveLength(1);
    expect(sentToBot(posts)[0]).toMatch(/Ship it\.$/);
  });

  it.each([["Yes."], ["No, wait."], ["Let's wait."], ["The first one."], ["네."]])("%s is an answer to the card", async (line) => {
    const { call, engine, posts } = await started({ responses: { "/messages": ACCEPTED } });
    engine().events.turnDone();
    call.observe({ busy: false, messages: [shipCard("q1")] });
    turn(engine(), "", "Is it OK to ship 1.0.263 now? Ship it, or wait?");
    engine().events.heard(line);
    engine().events.answering();
    await flush();
    expect(sentToBot(posts)).toHaveLength(1);
  });

  it.each([["Wait, what?"], ["Hi, Jennifer."], ["Hey, no. Oh, hi."], ["Can you check the build first?"]])("%s is not an answer to the card", async (line) => {
    const { call, engine, posts } = await started({ responses: { "/messages": ACCEPTED } });
    engine().events.turnDone();
    call.observe({ busy: false, messages: [shipCard("q1")] });
    turn(engine(), "", "Is it OK to ship 1.0.263 now? Ship it, or wait?");
    engine().events.heard(line);
    engine().events.answering();
    await flush();
    expect(sentToBot(posts)).toEqual([]);
  });

  it("after small talk the voice can still ask or offer work", async () => {
    const { call, engine } = await started({ responses: { "/messages": ACCEPTED } });
    engine().events.turnDone();
    call.observe({ busy: false, messages: [shipCard("q1")] });
    turn(engine(), "", "Is it OK to ship 1.0.263 now? Ship it, or wait?");
    engine().events.heard("Can you open my Desktop folder?");
    engine().events.answering();
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Open my Desktop folder." } }]);
    expect(call.state().pending?.order).toBe("Open my Desktop folder.");
  });

  it("F4 talking over the question does not get it re-sent while the person is still mid-sentence", async () => {
    const { call, audio, engine } = await started();
    engine().events.turnDone();
    call.observe({ busy: false, messages: [...HISTORY, shipCard("q1")] });
    expect(readouts(engine())).toHaveLength(1);
    cutOff(engine(), audio, "Is it OK to");
    expect(readouts(engine())).toHaveLength(1);
  });

  it("F4 echo or noise that keeps tripping barge-in does not make the question read forever", async () => {
    vi.useFakeTimers();
    const { call, audio, engine } = await started();
    engine().events.turnDone();
    call.observe({ busy: false, messages: [...HISTORY, shipCard("q1")] });
    for (let i = 0; i < 5; i += 1) {
      engine().events.answering();
      engine().events.said("Is it OK to ship");
      audio.onStart();
      audio.playing = true;
      engine().events.interrupted();
      engine().events.turnDone();
      audio.playing = false;
      audio.onIdle();
      await wait(5_000);
    }
    expect(readouts(engine())).toHaveLength(2);
  });

  it("A02 saying hi over the question re-reads it once, after his line and the voice's answer, then leaves it on screen", async () => {
    vi.useFakeTimers();
    const { call, audio, engine } = await started();
    engine().events.turnDone();
    call.observe({ busy: false, messages: [shipCard("q1")] });
    expect(readouts(engine())).toHaveLength(1);
    for (let i = 0; i < 3; i += 1) {
      engine().events.answering();
      engine().events.said("Is it OK to ship");
      engine().events.heard("I was just saying hi to you.");
      engine().events.interrupted();
      expect(readouts(engine())).toHaveLength(Math.min(2, i + 1));
      engine().events.answering();
      engine().events.said("Hi.");
      engine().events.turnDone();
      audio.onIdle();
      expect(readouts(engine())).toHaveLength(Math.min(2, i + 1));
      await wait(1_500);
      expect(readouts(engine())).toHaveLength(2);
    }
  });

  it("F6 the question already read out is not handed to the voice again with every status change", async () => {
    const { call, engine } = await started();
    engine().events.turnDone();
    const rows = [...HISTORY, shipCard("q1")];
    call.observe({ busy: false, messages: [...rows] });
    turn(engine(), "", "Is it OK to ship 1.0.263 now? Ship it, or wait?");
    rows.push(paneNote("note", "PICKER"));
    call.observe({ busy: true, messages: [...rows] });
    turn(engine(), "", "");
    const fedAgain = [...engine().contexts, ...engine().texts.slice(2)].filter((text) => text.includes("Is it OK to ship"));
    expect(fedAgain).toEqual([]);
    expect(engine().contexts.some((text) => text.includes("PICKER reported DONE"))).toBe(true);
  });

  it("A13 an answer given in a call is kept, so the next call does not ask again", async () => {
    vi.useFakeTimers();
    const card = shipCard("q1", 100, { staysOpen: true, options: ["Yes", "No"] });
    const first = await started({ responses: { "/messages": ACCEPTED } });
    first.engine().events.turnDone();
    turn(first.engine(), "Hi.", "Hey!");
    first.call.observe({ busy: false, messages: [card] });
    await wait(1_500);
    turn(first.engine(), "", "Is it OK to ship 1.0.263 now? Yes or no?");
    turn(first.engine(), "Yes.", "On it.");
    await flush();
    const sent = first.posts.find((p) => p.path === "/api/bots/b1/messages");
    expect(sent).toBeDefined();
    const persisted = [card, userRow("answer", sent!.body.text, { at: 2_100, call: sent!.body.call })];
    first.call.observe({ busy: false, messages: persisted });
    first.call.end();
    const second = await started({ callId: "c-abcdefabcdef" });
    second.engine().events.turnDone();
    second.call.observe({ busy: false, messages: persisted });
    turn(second.engine(), "Hi.", "Hey!");
    await wait(5_000);
    expect(readouts(second.engine())).toEqual([]);
  });
});

describe("4 greeting first", () => {
  it("F5 a question open at call start waits for the greeting, and the first hello is not its answer", async () => {
    const { call, engine, posts } = await started({ responses: { "/messages": ACCEPTED } });
    call.observe({ busy: true, messages: [...HISTORY, shipCard("q1", 10)] });
    const beforeGreetingEnds = engine().texts.length;
    turn(engine(), "", "Hey, I'm here.");
    engine().events.heard("Hi, Jennifer.");
    engine().events.answering();
    await flush();
    expect({ linesSentBeforeTheGreetingEnded: beforeGreetingEnds, sentToBot: sentToBot(posts) }).toEqual({ linesSentBeforeTheGreetingEnded: 1, sentToBot: [] });
  });

  it("A04 the greeting finishes before an old question goes in", async () => {
    const { call, engine } = await started();
    call.observe({ busy: false, messages: [shipCard("q1", 100)] });
    expect(engine().texts).toHaveLength(1);
  });

  it("nothing else plays until the greeting has played out", async () => {
    vi.useFakeTimers();
    const { call, audio, engine } = await started();
    call.observe({ busy: false, messages: [...HISTORY, userRow("u", "Check CI."), botRow("r", "CI is green."), shipCard("q1")], needs: { id: "n1", short: "approve a command" } });
    await wait(5_000);
    expect(engine().texts).toHaveLength(1);
    engine().events.answering();
    engine().events.said("Hey, I'm here.");
    audio.onStart();
    audio.playing = true;
    engine().events.turnDone();
    await wait(5_000);
    expect(engine().texts).toHaveLength(1);
    audio.playing = false;
    audio.onIdle();
    await wait(1_500);
    expect(engine().texts).toHaveLength(2);
  });

  it("the greeting's own turn end never arms a question", async () => {
    const { call, engine, posts } = await started({ responses: { "/messages": ACCEPTED } });
    call.observe({ busy: false, messages: [shipCard("q1")] });
    turn(engine(), "", "Hey, I'm here.");
    engine().events.heard("Yes.");
    engine().events.answering();
    await flush();
    expect(sentToBot(posts)).toEqual([]);
  });

  it("a question open at call start is read after the first exchange", async () => {
    vi.useFakeTimers();
    const { call, engine } = await started();
    call.observe({ busy: false, messages: [...HISTORY, shipCard("q1", 10)] });
    turn(engine(), "", "Hey, I'm here.");
    await wait(5_000);
    expect(readouts(engine())).toEqual([]);
    turn(engine(), "Hi, how's it going?", "Good! Busy with the picker.");
    await wait(1_500);
    expect(readouts(engine())).toHaveLength(1);
  });
});

describe("5 the name it is shown by", () => {
  it("F7 the name he knows the voice by wakes it: \"Jennifer, you can talk now\"", async () => {
    const { call, engine } = await started({ voice: "Aoede" });
    engine().events.turnDone();
    turn(engine(), "Be quiet, please.", "Okay.");
    expect(call.state().hushed).toBe(true);
    engine().events.heard("Jennifer, you can talk now.");
    engine().events.answering();
    expect(call.state().hushed).toBeUndefined();
  });

  it("A06 \"Jenn, are you there?\" wakes a hushed Chief of Staff", async () => {
    const { call, engine } = await started({ voice: "Aoede" });
    engine().events.turnDone();
    turn(engine(), "Be quiet, please.", "Okay.");
    engine().events.heard("Jenn, are you there?");
    expect(call.state().hushed).toBeUndefined();
  });

  it("each picker voice answers to its own shown name only", async () => {
    const { call, engine } = await started({ voice: "Alnilam" });
    engine().events.turnDone();
    turn(engine(), "Eddie, be quiet.", "Okay.");
    expect(call.state().hushed).toBe(true);
    engine().events.heard("Jenn, are you there?");
    expect(call.state().hushed).toBe(true);
    engine().events.heard(" Eddie?");
    expect(call.state().hushed).toBeUndefined();
    expect(callsVoice("Hi Jennifer", "Chief of Staff")).toBe(false);
    expect(callsVoice("Hi Jennifer", "Chief of Staff", "Jenn")).toBe(true);
  });
});

describe("6 hush and wake", () => {
  it("\"Be quiet, please.\" hushes, and nothing held is told until a wake", async () => {
    const { call, audio, engine } = await started();
    engine().events.turnDone();
    const told = engine().texts.length;
    engine().events.heard("Be quiet, please.");
    engine().events.answering();
    engine().events.audio(new Int16Array([500, -500]));
    engine().events.said("Okay.");
    engine().events.turnDone();
    expect(call.state().hushed).toBe(true);
    call.observe({ busy: false, messages: [...HISTORY, userRow("u", "Check CI."), botRow("r", "CI is green."), shipCard("q1")], needs: { id: "n1", short: "approve a command" } });
    await flush();
    turn(engine(), "So anyway, what do you want for lunch?", "Want me to look up lunch places?");
    expect({ played: audio.played, told: engine().texts.length - told }).toEqual({ played: 0, told: 0 });
  });

  it("F11 plain ways to ask for quiet hush the call", () => {
    const lines = ["Quiet.", "Quiet, please.", "Be quiet for a second.", "Can you be quiet for a minute?", "Stop talking for a second.", "Silence.", "Enough.", "That's enough.", "No more updates.", "조용.", "그만 말해.", "그만 말해도 돼.", "시끄러워."];
    expect(lines.filter((line) => !asksForQuiet(line, "Chief of Staff"))).toEqual([]);
    const talk = ["Stop talking about the tests.", "If I say be quiet, can you do that?", "That's enough money for now?", "Is it quiet in there?", "영어로 말하지 마."];
    expect(talk.filter((line) => asksForQuiet(line, "Chief of Staff"))).toEqual([]);
    expect(asksForQuiet("Jenn, be quiet.", "Chief of Staff", "Jenn")).toBe(true);
  });

  it("A05 a whole quiet line latches before the model has started answering", async () => {
    vi.useFakeTimers();
    const { call, engine } = await started();
    engine().events.turnDone();
    engine().events.heard("Be quiet, please.");
    await wait(1_300);
    expect(call.state().hushed).toBe(true);
  });

  it("F12 waking after a hush reads only the newest update and says a few things came in", async () => {
    vi.useFakeTimers();
    const { call, engine } = await started();
    engine().events.turnDone();
    turn(engine(), "Be quiet, please.", "Okay.");
    const rows = [...HISTORY];
    for (const n of [1, 2, 3, 4]) {
      rows.push(userRow(`u${n}`, `Check job ${n}.`), botRow(`r${n}`, `Job ${n} is done.`));
      call.observe({ busy: false, messages: [...rows] });
      await flush();
    }
    engine().events.heard("Hey, what's up?");
    engine().events.answering();
    engine().events.said("Hey.");
    engine().events.turnDone();
    for (let i = 0; i < 4; i += 1) {
      await wait(1_500);
      engine().events.turnDone();
    }
    expect(replies(engine())).toHaveLength(1);
    expect(replies(engine())[0]).toMatch(/a few things came in/i);
    expect(replies(engine())[0]).toContain("Job 4 is done.");
    expect(engine().contexts.filter((text) => /Job [123] is done/.test(text))).toHaveLength(3);
  });
});

describe("first 30 seconds, replayed", () => {
  it("his call with the Chief of Staff, line by line", async () => {
    const { call, audio, engine, posts, said } = await started({ responses: { "/messages": ACCEPTED, "/api/tts/prepare": { status: 200, data: {} } } });
    const wrong: string[] = [];
    const rows = [...HISTORY, shipCard("q1", 10)];
    // 0 s: connected. The bot is busy, so its chat changes before the greeting has played.
    call.observe({ busy: true, messages: [...rows] });
    if (engine().texts.length > 1) wrong.push("the question went out on top of the greeting");
    turn(engine(), "", "Hey, I'm here.");
    // 4 s: the voice reads the question; he says hello over it.
    cutOff(engine(), audio, "Is it OK to");
    if (readouts(engine()).length > 1) wrong.push("the question was sent again while he was still saying hello");
    engine().events.heard("Hey, no. Oh, hi. Hi, Jennifer.");
    turn(engine(), "", "Hi! Let's circle back. Is it OK to ship 1.0.263 now?");
    // 12 s: he explains himself.
    engine().events.heard("I was just saying hi to you.");
    engine().events.answering();
    await flush();
    if (sentToBot(posts).length) wrong.push(`"${sentToBot(posts)[0]}" went to the bot as the answer to its question`);
    engine().events.said("Got it.");
    engine().events.turnDone();
    // 18 s: a worker reports, the bot writes a line about it, nobody asked.
    rows.push(paneNote("note", "PICKER"), botRow("wake", "I'm merging the picker fix now that its worker reported done."));
    engine().events.heard("If I say be quiet, can you do that?");
    engine().events.answering();
    call.observe({ busy: false, messages: [...rows] });
    await flush();
    engine().events.said("Yes, just say be quiet.");
    engine().events.turnDone();
    if (replies(engine()).length) wrong.push("a worker update was read out the moment the voice said yes");
    expect({ wrong, voices: [...new Set(said.map((u) => u.voice))], heardLines: linesOf(posts).length > 0 }).toEqual({ wrong: [], voices: ["Aoede"], heardLines: true });
  });
});
