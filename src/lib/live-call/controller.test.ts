import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CallLine } from "../../../shared/live-call";
import type { Message } from "@/state/store-types";
import { LiveCall, spokenText, told, type CallAudioPort, type Posted } from "./controller";
import type { LiveEngine, LiveEvents } from "./engine";

class FakeEngine implements LiveEngine {
  events!: LiveEvents;
  texts: string[] = [];
  contexts: string[] = [];
  results: Array<{ id: string; result: unknown }> = [];
  paused = 0;
  closed = false;
  connect(_session: unknown, events: LiveEvents) { this.events = events; }
  sendAudio() {}
  audioPaused() { this.paused += 1; }
  sendText(text: string) { this.texts.push(text); }
  sendContext(text: string) { this.contexts.push(text); }
  sendToolResult(id: string, _name: string, result: unknown) { this.results.push({ id, result }); }
  close() { this.closed = true; }
}

function fakeAudio(): CallAudioPort & { flushed: number } {
  return {
    flushed: 0,
    playing: false,
    async capture() {},
    play() {},
    flush() { this.flushed += 1; },
    close() {},
    heardShare: () => 0.5,
    onIdle: () => {},
    onStart: () => {},
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(responses: Record<string, Posted | (() => Promise<Posted>)> = {}, audio: CallAudioPort = fakeAudio()) {
  const engines: FakeEngine[] = [];
  const posts: Array<{ path: string; body: any }> = [];
  const call = new LiveCall({
    botId: "b1",
    botName: "Nova",
    device: "phone",
    engine: () => { const engine = new FakeEngine(); engines.push(engine); return engine; },
    audio,
    now: () => 1_000,
    post: async (path, body) => {
      posts.push({ path, body });
      const hit = Object.entries(responses).find(([suffix]) => path.endsWith(suffix));
      if (hit) return typeof hit[1] === "function" ? hit[1]() : hit[1];
      if (path.endsWith("/call/token")) return { status: 200, data: { callId: "c-0123456789ab", url: "wss://x", token: "t", model: "m" } };
      return { status: 200, data: {} };
    },
  });
  return { call, engines, posts, engine: () => engines.at(-1)! };
}

async function started(responses?: Record<string, Posted | (() => Promise<Posted>)>, audio?: CallAudioPort) {
  const s = setup(responses, audio);
  await s.call.start();
  s.engine().events.ready();
  return s;
}

const botRow = (id: string, text: string, extra: Partial<Message> = {}): Message => ({ id, role: "bot", kind: "text", text, at: 2_000, ...extra }) as Message;
const userRow = (id: string, text: string, extra: Partial<Message> = {}): Message => ({ id, role: "user", kind: "text", text, at: 2_000, ...extra }) as Message;
const orderRow = (id: string, text: string) => userRow(id, text, { call: { id: "c-0123456789ab", order: true } });

beforeEach(() => { vi.stubGlobal("crypto", { randomUUID: () => "send-1" }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("spokenText", () => {
  it("drops transcript markers", () => {
    expect(spokenText("<no speech>{pause}")).toBe("");
    expect(spokenText("...")).toBe("");
    expect(spokenText(" Hi {pause} there ")).toBe("Hi there");
  });
});

describe("LiveCall", () => {
  it("needs a key on 409 and greets once connected", async () => {
    const needs = setup({ "/call/token": { status: 409, data: { error: "Add a Gemini key to call.", cardId: "k1" } } });
    await needs.call.start();
    expect(needs.call.state().status).toBe("needsKey");
    expect(needs.engines).toHaveLength(0);

    const { call, engine } = await started();
    expect(call.state().status).toBe("listening");
    expect(engine().texts[0]).toMatch(/^\[Wink\] The call just started/);
  });

  it("posts heard and said lines tagged through one route, filtering markers", async () => {
    const { engine, posts } = await started();
    engine().events.heard("Hello ");
    engine().events.heard("there");
    engine().events.answering();
    engine().events.said("<no speech>");
    engine().events.turnDone();
    engine().events.said("Hi, Edward.");
    engine().events.turnDone();
    const lines = posts.filter((p) => p.path.endsWith("/call/lines")).map((p) => p.body);
    expect(lines).toEqual([
      { callId: "c-0123456789ab", lines: [{ who: "user", text: "Hello there", at: 1_000 }] },
      { callId: "c-0123456789ab", lines: [{ who: "voice", text: "Hi, Edward.", at: 1_000 }] },
    ]);
  });

  it("captions the line being spoken, keeping the last one after its turn", async () => {
    const { call, engine } = await started();
    expect(call.state().caption).toBeUndefined();
    engine().events.heard("Can you fix ");
    expect(call.state().caption).toEqual({ id: 1, who: "user", text: "Can you fix" });
    engine().events.heard("the login bug?");
    expect(call.state().caption).toEqual({ id: 1, who: "user", text: "Can you fix the login bug?" });
    engine().events.answering();
    engine().events.said("<no speech>");
    expect(call.state().caption?.who).toBe("user");
    engine().events.said("Sure, {pause} on it.");
    expect(call.state().caption).toEqual({ id: 2, who: "voice", text: "Sure, on it." });
    engine().events.turnDone();
    expect(call.state().caption).toEqual({ id: 2, who: "voice", text: "Sure, on it." });
    engine().events.said("Next.");
    expect(call.state().caption).toEqual({ id: 3, who: "voice", text: "Next." });
  });

  it("sends an order after a tapped yes, tagged as an order", async () => {
    const { call, engine, posts } = await started({ "/messages": { status: 202, data: { ok: true } } });
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Fix the login bug." } }]);
    expect(call.state().pending?.order).toBe("Fix the login bug.");
    await call.answer(true);
    const sent = posts.find((p) => p.path === "/api/bots/b1/messages");
    expect(sent?.body).toEqual({ text: "Fix the login bug.", sendId: "send-1", call: { id: "c-0123456789ab", order: true } });
    expect(engine().results).toEqual([{ id: "t1", result: "sent" }]);
    expect(call.state().pending).toBeUndefined();
    expect(call.state().status).toBe("working");
  });

  it("takes a spoken yes in Korean and reports queued", async () => {
    const { engine, posts } = await started({ "/messages": { status: 202, data: { ok: true, queued: true } } });
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "로그인 버그 고쳐줘" } }]);
    engine().events.heard("은 보내줘.");
    engine().events.answering();
    await flush();
    expect(posts.some((p) => p.path === "/api/bots/b1/messages")).toBe(true);
    expect(engine().results).toEqual([{ id: "t1", result: "queued" }]);
  });

  it("declines on a spoken no and ignores ambiguous words", async () => {
    const { call, engine, posts } = await started();
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Deploy." } }]);
    engine().events.heard("hmm let me think");
    engine().events.answering();
    expect(call.state().pending).toBeDefined();
    engine().events.heard("No, wait.");
    engine().events.answering();
    expect(engine().results).toEqual([{ id: "t1", result: "declined" }]);
    expect(posts.some((p) => p.path.endsWith("/messages"))).toBe(false);
  });

  it("expires an order after 45 s, replaces one on a new proposal, keeps it on cancel", async () => {
    vi.useFakeTimers();
    const { call, engine } = await started();
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "A" } }]);
    engine().events.toolCall([{ id: "t2", name: "propose_work", args: { order: "B" } }]);
    expect(engine().results).toEqual([{ id: "t1", result: "replaced" }]);
    vi.advanceTimersByTime(45_000);
    expect(engine().results.at(-1)).toEqual({ id: "t2", result: "expired" });
    engine().events.toolCall([{ id: "t3", name: "propose_work", args: { order: "C" } }]);
    engine().events.toolCancel(["t3"]);
    expect(call.state().pending?.order).toBe("C");
    engine().events.toolCall([{ id: "t4", name: "nope", args: {} }]);
    expect(engine().results.at(-1)).toEqual({ id: "t4", result: "unknown tool" });
  });

  it("guards a spoken done while the bot still works, once per turn, en and ko", async () => {
    const { call, engine } = await started({ "/messages": { status: 202, data: { ok: true } } });
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Fix it." } }]);
    await call.answer(true);
    engine().events.said("All done, I fixed it.");
    engine().events.said(" Fixed.");
    engine().events.turnDone();
    engine().events.said("수정했어요.");
    expect(engine().texts.filter((t) => t === "[Wink] Not done yet: Nova is still working.")).toHaveLength(2);
    call.end();
  });

  it("relays the settled reply once, skipping voice, quick and older rows", async () => {
    const { call, engine } = await started({ "/api/tts/prepare": { status: 200, data: { utterances: ["Fixed the bug.", "Tests pass."] } } });
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Fix the bug." } }]);
    await call.answer(true);
    const rows = [
      botRow("old", "before", { at: 10 }),
      botRow("v", "voice", { call: { id: "c-0123456789ab", voice: true } }),
      botRow("q", "quick", { quick: { state: "answer" } }),
      orderRow("o", "Fix the bug."),
      botRow("r", "Fixed the bug. Tests pass."),
    ];
    call.observe({ busy: true, messages: rows });
    await flush();
    expect(engine().texts.some((t) => t.includes("replied"))).toBe(false);
    call.observe({ busy: false, messages: rows });
    call.observe({ busy: false, messages: rows });
    await flush();
    expect(engine().texts.filter((t) => t.includes("replied"))).toEqual(["[Wink] Nova replied: Fixed the bug. Tests pass."]);
  });

  it("typed message reply is not spoken", async () => {
    const { call, engine } = await started();
    call.observe({ busy: false, messages: [botRow("r", "Here is the plan.")] });
    await flush();
    expect(engine().texts.some((t) => t.includes("replied"))).toBe(false);
  });

  it("typed reply reaches the voice as silent context", async () => {
    const audio = { ...fakeAudio(), playing: false };
    const { call, engine } = await started({}, audio);
    const rows = [{ id: "u", role: "user", kind: "text", text: "What broke?", at: 2_000 } as Message, botRow("r", "The login token expired.")];
    audio.onStart();
    audio.playing = true;
    call.observe({ busy: false, messages: rows });
    expect(engine().contexts).toEqual([]);
    audio.playing = false;
    engine().events.turnDone();
    call.observe({ busy: false, messages: rows });
    expect(engine().contexts).toEqual(["[Wink] Typed in chat, already on screen. Context only, do not read it out.\nUser: What broke?\nNova: The login token expired."]);
    expect(engine().texts.some((t) => t.includes("replied"))).toBe(false);
  });

  it("voice order reply is spoken", async () => {
    const { call, engine } = await started();
    call.observe({ busy: false, messages: [botRow("typed", "Typed answer.")] });
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Fix it." } }]);
    await call.answer(true);
    call.observe({ busy: false, messages: [botRow("typed", "Typed answer."), orderRow("o", "Fix it."), botRow("r", "Fixed.")] });
    await flush();
    expect(engine().texts.filter((t) => t.includes("replied"))).toEqual(["[Wink] Nova replied: Fixed."]);
  });

  it("each voice order reply is spoken, a typed reply between stays silent", async () => {
    const { call, engine } = await started();
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Do A." } }]);
    await call.answer(true);
    engine().events.toolCall([{ id: "t2", name: "propose_work", args: { order: "Do B." } }]);
    await call.answer(true);
    call.observe({ busy: false, messages: [orderRow("o1", "Do A."), userRow("u", "What time is it?"), botRow("t", "Noon.")] });
    await flush();
    call.observe({ busy: false, messages: [orderRow("o1", "Do A."), userRow("u", "What time is it?"), botRow("t", "Noon."), orderRow("o2", "Do B."), botRow("b", "B done.")] });
    await flush();
    call.observe({ busy: false, messages: [orderRow("o1", "Do A."), botRow("a", "A done."), userRow("u", "What time is it?"), botRow("t", "Noon."), orderRow("o2", "Do B."), botRow("b", "B done.")] });
    await flush();
    expect(engine().texts.filter((t) => t.includes("replied"))).toEqual(["[Wink] Nova replied: B done.", "[Wink] Nova replied: A done."]);
    expect(engine().contexts).toHaveLength(1);
    expect(engine().contexts[0]).toContain("Nova: Noon.");
  });

  it("speaks the final voice-order report after typed steering", async () => {
    const { call, engine } = await started();
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Find the login bug." } }]);
    await call.answer(true);
    const rows = [orderRow("o", "Find the login bug."), botRow("c", "Checking the login flow.")];
    call.observe({ busy: true, messages: rows });
    rows.push(userRow("u", "Focus on expired sessions.", { steered: true }), botRow("r", "Expired sessions cause the login bug."));
    call.observe({ busy: false, messages: rows });
    call.observe({ busy: false, messages: rows });
    await flush();
    expect(engine().texts.filter((t) => t.includes("replied"))).toEqual(["[Wink] Nova replied: Expired sessions cause the login bug."]);
    expect(engine().contexts.filter((t) => t.startsWith("[Wink] Typed"))).toEqual([]);
    expect(call.state().status).toBe("listening");
  });

  it("settles two voice orders sharing one completed turn", async () => {
    const { call, engine } = await started();
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Inspect package.json" } }]);
    await call.answer(true);
    engine().events.toolCall([{ id: "t2", name: "propose_work", args: { order: "Also inspect README" } }]);
    await call.answer(true);
    const rows = [orderRow("o1", "Inspect package.json"), { ...orderRow("o2", "Also inspect README"), steered: true }];
    call.observe({ busy: true, messages: rows });
    rows.push(botRow("r", "Both files are consistent."));
    call.observe({ busy: false, messages: rows });
    call.observe({ busy: false, messages: rows });
    await flush();
    expect(engine().texts.filter((t) => t.includes("replied"))).toEqual(["[Wink] Nova replied: Both files are consistent."]);
    expect(call.state().status).toBe("listening");
    engine().events.turnDone();
    engine().events.said("All done.");
    expect(engine().texts.filter((t) => t.startsWith("[Wink] Not done yet"))).toEqual([]);
  });

  it("keeps a later queued order pending after a shared turn settles", async () => {
    const { call, engine } = await started({ "/messages": { status: 202, data: { ok: true, queued: true } } });
    for (const order of ["Do A.", "Do B.", "Do C."]) {
      engine().events.toolCall([{ id: order, name: "propose_work", args: { order } }]);
      await call.answer(true);
    }
    const rows = [orderRow("o1", "Do A."), { ...orderRow("o2", "Do B."), steered: true }, botRow("ab", "A and B done.")];
    call.observe({ busy: false, messages: rows });
    call.observe({ busy: false, messages: rows });
    await flush();
    expect(call.state().status).toBe("working");
    engine().events.turnDone();
    engine().events.said("All done.");
    expect(engine().texts.filter((t) => t.startsWith("[Wink] Not done yet"))).toHaveLength(1);
    rows.push(orderRow("o3", "Do C."), botRow("c", "C done."));
    call.observe({ busy: false, messages: rows });
    await flush();
    expect(call.state().status).toBe("listening");
    expect(engine().texts.filter((t) => t.includes("replied"))).toEqual(["[Wink] Nova replied: A and B done.", "[Wink] Nova replied: C done."]);
  });

  it("settles an order only once when another reply arrives", async () => {
    const { call, engine } = await started();
    for (const order of ["Do A.", "Do B."]) {
      engine().events.toolCall([{ id: order, name: "propose_work", args: { order } }]);
      await call.answer(true);
    }
    const rows = [orderRow("o1", "Do A."), botRow("a", "A done.")];
    call.observe({ busy: false, messages: rows });
    await flush();
    rows.push(botRow("a2", "A verified."));
    call.observe({ busy: false, messages: rows });
    await flush();
    expect(call.state().status).toBe("working");
    expect(engine().texts.filter((t) => t.includes("replied"))).toEqual(["[Wink] Nova replied: A done.", "[Wink] Nova replied: A verified."]);
    rows.push(orderRow("o2", "Do B."), botRow("b", "B done."));
    call.observe({ busy: false, messages: rows });
    await flush();
    expect(call.state().status).toBe("listening");
  });

  it("a quick ask during a voice order keeps the order reply spoken", async () => {
    const { call, engine } = await started();
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Do A." } }]);
    await call.answer(true);
    call.observe({ busy: false, messages: [orderRow("o", "Do A."), userRow("q", "Quick one?", { quick: { state: "asked" } }), botRow("qa", "Yes.", { quick: { state: "answer" } }), botRow("r", "A done.")] });
    await flush();
    expect(engine().texts.filter((t) => t.includes("replied"))).toEqual(["[Wink] Nova replied: A done."]);
    expect(engine().contexts).toEqual([]);
  });

  it("a relayed report is not flagged as an invented done", async () => {
    const { call, engine } = await started();
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Do A." } }]);
    await call.answer(true);
    engine().events.toolCall([{ id: "t2", name: "propose_work", args: { order: "Do B." } }]);
    await call.answer(true);
    call.observe({ busy: false, messages: [orderRow("o1", "Do A."), botRow("a", "A done.")] });
    await flush();
    engine().events.said("All done, I fixed A.");
    engine().events.turnDone();
    expect(engine().texts.filter((t) => t.startsWith("[Wink] Not done yet"))).toHaveLength(0);
    engine().events.said("B is done too.");
    expect(engine().texts.filter((t) => t.startsWith("[Wink] Not done yet"))).toHaveLength(1);
  });

  it("typed context trims the typed text so the reply fits", async () => {
    const { call, engine } = await started();
    call.observe({ busy: false, messages: [userRow("u", "x".repeat(2_000)), botRow("r", "Short answer.")] });
    expect(engine().contexts[0]!.length).toBeLessThanOrEqual(1_500);
    expect(engine().contexts[0]).toMatch(/xxx\nNova: Short answer\.$/);
  });

  it("keeps held context through a reconnect", async () => {
    const audio = { ...fakeAudio(), playing: false };
    const { call, engines, engine } = await started({}, audio);
    audio.onStart();
    audio.playing = true;
    engine().events.turnDone();
    call.observe({ busy: false, messages: [userRow("u", "What broke?"), botRow("r", "The token expired.")] });
    engine().events.resumable("h1");
    engine().events.goAway();
    audio.playing = false;
    audio.onIdle();
    await flush();
    engine().events.ready();
    expect(engines[0]!.contexts).toEqual([]);
    expect(engine().contexts).toHaveLength(1);
  });

  it("holds the report until the voice finishes its turn", async () => {
    const audio = { ...fakeAudio(), playing: false };
    const { call, engine } = await started({ "/api/tts/prepare": { status: 200, data: { utterances: ["Fixed."] } } }, audio);
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Fix it." } }]);
    await call.answer(true);
    audio.onStart();
    audio.playing = true;
    call.observe({ busy: false, messages: [orderRow("o", "Fix it."), botRow("r", "Fixed.")] });
    await flush();
    expect(engine().texts.some((t) => t.includes("replied"))).toBe(false);
    engine().events.turnDone();
    expect(engine().texts.some((t) => t.includes("replied"))).toBe(false);
    audio.playing = false;
    audio.onIdle();
    expect(engine().texts.filter((t) => t.includes("replied"))).toEqual(["[Wink] Nova replied: Fixed."]);
  });

  it("tells the voice once when a card waits on the user", async () => {
    const { call, engine } = await started();
    call.observe({ busy: true, messages: [], needs: { id: "n1", short: "approve a command" } });
    call.observe({ busy: true, messages: [], needs: { id: "n1", short: "approve a command" } });
    expect(engine().texts.filter((t) => t.includes("needs you"))).toEqual(["[Wink] Nova needs you in chat: approve a command"]);
  });

  it("a spoken answer to the bot's open question goes to the bot once, never as an order", async () => {
    const { call, engine, posts } = await started();
    const ask = { id: "ask", role: "bot", kind: "options", at: 2_000, card: { title: "Your bot has a question", subtitle: "Restart at 8:15 PM instead?", options: ["Yes, 8:15 PM"], askUser: true } } as Message;
    call.observe({ busy: true, messages: [ask] });
    engine().events.turnDone();
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Restart the home PC at 8:15 PM." } }]);
    expect(call.state().pending).toBeUndefined();
    expect(engine().results[0]?.result).toMatch(/^not needed/);
    engine().events.heard("Yeah, that's better.");
    engine().events.answering();
    engine().events.toolCall([{ id: "t2", name: "propose_work", args: { order: "Restart the home PC at 8:15 PM." } }]);
    expect(call.state().pending).toBeUndefined();
    await flush();
    const sends = posts.filter((p) => p.path === "/api/bots/b1/messages");
    expect(sends.map((p) => p.body)).toEqual([{ text: "Yeah, that's better.", sendId: "send-1", call: { id: "c-0123456789ab", ask: true } }]);
    expect(posts.some((p) => p.path.endsWith("/call/lines") && p.body.lines[0].who === "user")).toBe(false);
    engine().events.heard("Also open my Desktop folder.");
    engine().events.answering();
    engine().events.toolCall([{ id: "t3", name: "propose_work", args: { order: "Open my Desktop folder." } }]);
    expect(call.state().pending?.order).toBe("Open my Desktop folder.");
    engine().events.turnDone();
    const rows = [ask, userRow("a", "Yeah, that's better.", { call: { id: "c-0123456789ab", ask: true } }), botRow("r", "Restart set for 8:15 PM.")];
    call.observe({ busy: false, messages: rows });
    await flush();
    expect(engine().texts.filter((t) => t.includes("replied"))).toEqual(["[Wink] Nova replied: Restart set for 8:15 PM."]);
  });

  it("a failed spoken answer still lands as a call line", async () => {
    const { call, engine, posts } = await started({ "/messages": { status: 409, data: { error: "down" } } });
    call.observe({ busy: false, messages: [{ id: "ask", role: "bot", kind: "options", at: 2_000, card: { title: "q", subtitle: "8:15?", options: [], askUser: true } } as Message] });
    engine().events.turnDone();
    engine().events.heard("Yeah, that's better.");
    engine().events.answering();
    await flush();
    expect(posts.filter((p) => p.path.endsWith("/call/lines")).map((p) => p.body.lines[0].text)).toEqual(["Yeah, that's better."]);
  });

  it("the bot's reply to a spoken answer can offer new work", async () => {
    const { call, engine } = await started();
    const ask = { id: "ask", role: "bot", kind: "options", at: 2_000, card: { title: "q", subtitle: "8:15?", options: [], askUser: true } } as Message;
    call.observe({ busy: false, messages: [ask] });
    engine().events.turnDone();
    engine().events.heard("Yes.");
    engine().events.answering();
    await flush();
    call.observe({ busy: false, messages: [ask, userRow("a", "Yes.", { call: { id: "c-0123456789ab", ask: true } }), botRow("r", "Set for 8:15. Want me to close the panes first?")] });
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Close the panes." } }]);
    expect(call.state().pending?.order).toBe("Close the panes.");
  });

  it("a question from before the call keeps spoken lines as call lines", async () => {
    const { call, engine, posts } = await started();
    call.observe({ busy: false, messages: [{ id: "ask", role: "bot", kind: "options", at: 10, card: { title: "q", subtitle: "Old?", options: [], askUser: true } } as Message] });
    engine().events.heard("Hello?");
    engine().events.answering();
    expect(posts.some((p) => p.path.endsWith("/messages"))).toBe(false);
    expect(posts.filter((p) => p.path.endsWith("/call/lines"))).toHaveLength(1);
  });

  it("an order already sent or pending in this call is not shown again", async () => {
    const { call, engine, posts } = await started();
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Restart the home PC at 8:15 PM." } }]);
    engine().events.heard("Yeah.");
    engine().events.answering();
    await flush();
    engine().events.toolCall([{ id: "t2", name: "propose_work", args: { order: "restart the home PC at 8:15 PM" } }]);
    expect(call.state().pending).toBeUndefined();
    expect(engine().results).toEqual([{ id: "t1", result: "sent" }, { id: "t2", result: "already sent" }]);
    engine().events.toolCall([{ id: "t3", name: "propose_work", args: { order: "Check the build." } }]);
    engine().events.toolCall([{ id: "t4", name: "propose_work", args: { order: "Check the build" } }]);
    expect(engine().results.at(-1)).toEqual({ id: "t4", result: "already proposed, waiting for their answer" });
    await call.answer(false);
    engine().events.toolCall([{ id: "t5", name: "propose_work", args: { order: "Check the build." } }]);
    expect(call.state().pending?.order).toBe("Check the build.");
    expect(posts.filter((p) => p.path === "/api/bots/b1/messages")).toHaveLength(1);
  });

  it("flushes audio and cuts the voice line on interruption", async () => {
    const { engine, posts } = await started();
    engine().events.said("This is a long answer");
    engine().events.interrupted();
    const voice = posts.filter((p) => p.path.endsWith("/call/lines")).at(-1)?.body.lines[0];
    expect(voice.text).toBe("This is a l…");
  });

  it("reconnects with a fresh token and the handle after GoAway", async () => {
    const { engines, posts, engine } = await started();
    engine().events.resumable("h1");
    engine().events.goAway();
    await flush();
    expect(engines).toHaveLength(2);
    expect(engines[0]!.closed).toBe(true);
    expect(posts.filter((p) => p.path.endsWith("/call/token")).at(-1)?.body).toEqual({ locale: "en", callId: "c-0123456789ab", resume: true });
    engine().events.ready();
    expect(engine().texts).toEqual([]);
  });

  it("mutes with audioStreamEnd and writes stats on end", async () => {
    const { call, engine, posts } = await started();
    call.mute(true);
    expect(engine().paused).toBe(1);
    engine().events.heard("안녕");
    engine().events.answering();
    engine().events.usage(120);
    call.end();
    expect(call.state().status).toBe("ended");
    await flush();
    const end = posts.find((p) => p.path.endsWith("/call/end"))?.body;
    expect(end.callId).toBe("c-0123456789ab");
    expect(end.stats).toMatchObject({ device: "phone", userLines: 1, hangulShare: 1, usage: { total: 120 }, orders: { proposed: 0 } });
  });

  it("ends the call only after its last lines are saved", async () => {
    let save!: () => void;
    const { call, engine, posts } = await started({ "/call/lines": () => new Promise((resolve) => { save = () => resolve({ status: 200, data: {} }); }) });
    engine().events.heard("Is the password reset email fixed?");
    call.end();
    await flush();
    expect(posts.map((p) => p.path.split("/").at(-1))).toEqual(["token", "lines"]);
    save();
    await flush();
    expect(posts.map((p) => p.path.split("/").at(-1))).toEqual(["token", "lines", "end"]);
  });
});

const turn = (engine: FakeEngine, heard: string, said: string) => {
  if (heard) engine.events.heard(heard);
  engine.events.answering();
  engine.events.said(said);
  engine.events.turnDone();
};
const messagesOf = (posts: Array<{ path: string; body: any }>) => posts.filter((p) => p.path === "/api/bots/b1/messages");
const linesOf = (posts: Array<{ path: string; body: any }>) => posts.filter((p) => p.path.endsWith("/call/lines")).flatMap((p) => p.body.lines.map((line: CallLine) => line.text));
const nudges = (engine: FakeEngine) => engine.texts.filter((t) => t.startsWith("[Wink] Not done:"));
const cardRow = (id: string, at = 2_000) => ({ id, role: "bot", kind: "options", at, card: { title: "Your bot has a question", subtitle: "Restart at 8:15 PM?", options: ["Yes", "No"], askUser: true } }) as Message;
const askRow = (id: string, text: string, extra: Partial<Message> = {}) => userRow(id, text, { call: { id: "c-0123456789ab", ask: true }, ...extra });

describe("VOICE-SEND: dropped orders (D1-D7)", () => {
  it("D1 a promise with no tool call is caught", async () => {
    const { engine } = await started();
    turn(engine(), "Can you check when our eval loops are supposed to be done?", "I will check that for you right now.");
    expect(nudges(engine())).toEqual([`[Wink] Not done: you said "I will check that for you right now.", but nothing was sent, so nothing is running. Call ask or propose_work now, or say plainly it was not sent.`]);
  });

  it("D2 a false done with nothing in flight is caught", async () => {
    const { engine } = await started();
    turn(engine(), "Can you add that to the list?", "I have added the mobile reconnecting issue to your list.");
    expect(nudges(engine())).toHaveLength(1);
  });

  it("D3 a yes said over the offer still sends after a talk-over cancel, told as a [Wink] line", async () => {
    const { call, engine, posts } = await started({ "/messages": { status: 202, data: { ok: true } } });
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Open the Orbit folder." } }]);
    engine().events.toolCancel(["t1"]);
    expect(call.state().pending?.order).toBe("Open the Orbit folder.");
    engine().events.heard("Yes.");
    engine().events.answering();
    await flush();
    expect(messagesOf(posts)).toHaveLength(1);
    expect(engine().results).toEqual([]);
    engine().events.turnDone();
    expect(engine().texts.at(-1)).toBe("[Wink] Sent: Open the Orbit folder.");
  });

  it("D4 a final yes at hang-up sends before the call ends", async () => {
    const { call, engine, posts } = await started({ "/messages": { status: 202, data: { ok: true } } });
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Regain the folder." } }]);
    engine().events.heard("Yes.");
    call.end();
    await flush();
    await flush();
    expect(messagesOf(posts)).toHaveLength(1);
    expect(posts.map((p) => p.path.split("/").at(-1))).toEqual(["token", "lines", "messages", "end"]);
  });

  it("D4 an unanswered offer at hang-up leaves a Not sent line", async () => {
    const { call, engine, posts } = await started();
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Regain the folder." } }]);
    call.end();
    await flush();
    expect(linesOf(posts)).toEqual(["Not sent (call ended): Regain the folder."]);
    expect(posts.find((p) => p.path.endsWith("/call/end"))?.body.stats.orders).toMatchObject({ proposed: 1, dropped: 1 });
  });

  it("D5 two offers in one tool message merge into one order, answered once per id", async () => {
    const { call, engine, posts } = await started({ "/messages": { status: 202, data: { ok: true } } });
    engine().events.toolCall([
      { id: "t1", name: "propose_work", args: { order: "Open the Orbit folder." } },
      { id: "t2", name: "propose_work", args: { order: "Check the eval times." } },
    ]);
    expect(engine().results).toEqual([]);
    expect(call.state().pending?.order).toBe("Open the Orbit folder. Check the eval times.");
    await call.answer(true);
    expect(messagesOf(posts).map((p) => p.body.text)).toEqual(["Open the Orbit folder. Check the eval times."]);
    expect(engine().results).toEqual([{ id: "t1", result: "sent" }, { id: "t2", result: "sent" }]);
  });

  it("D5 a later offer replaces the old one, never as a no", async () => {
    const { call, engine, posts } = await started();
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "A" } }]);
    engine().events.toolCall([{ id: "t2", name: "propose_work", args: { order: "B" } }]);
    expect(engine().results).toEqual([{ id: "t1", result: "replaced" }]);
    call.end();
    await flush();
    expect(posts.find((p) => p.path.endsWith("/call/end"))?.body.stats.orders).toMatchObject({ proposed: 2, replaced: 1, declined: 0 });
  });

  it("D7 the same order later in the call is offered again once its reply settled", async () => {
    const { call, engine, posts } = await started();
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Check the build." } }]);
    await call.answer(true);
    call.observe({ busy: false, messages: [orderRow("o1", "Check the build."), botRow("r1", "Build is red.")] });
    engine().events.toolCall([{ id: "t2", name: "propose_work", args: { order: "Check the build." } }]);
    expect(engine().results.at(-1)).not.toEqual({ id: "t2", result: "already sent" });
    expect(call.state().pending?.order).toBe("Check the build.");
    expect(messagesOf(posts)).toHaveLength(1);
  });
});

describe("VOICE-SEND: ask", () => {
  it("sends a question at once, tagged as an ask, with no yes", async () => {
    const { call, engine, posts } = await started({ "/messages": { status: 202, data: { ok: true } } });
    engine().events.heard("Does voice use Opus tokens?");
    engine().events.answering();
    engine().events.toolCall([{ id: "t1", name: "ask", args: { question: "Does voice use Opus tokens?" } }]);
    await flush();
    expect(messagesOf(posts).map((p) => p.body)).toEqual([{ text: "Does voice use Opus tokens?", sendId: "send-1", call: { id: "c-0123456789ab", ask: true } }]);
    expect(engine().results).toEqual([{ id: "t1", result: "sent" }]);
    expect(call.state().pending).toBeUndefined();
    expect(call.state().status).toBe("working");
    engine().events.said("Let me check.");
    engine().events.turnDone();
    expect(nudges(engine())).toEqual([]);
  });

  it.each(["Can you restart the home PC at 1 AM?", "바탕화면 폴더 열어줄 수 있어?", "Could you add that to my list?"])("keeps a change request on propose_work: %s", async (question) => {
    const { engine, posts } = await started();
    engine().events.toolCall([{ id: "t1", name: "ask", args: { question } }]);
    await flush();
    expect(messagesOf(posts)).toEqual([]);
    expect(engine().results[0]?.result).toMatch(/^not sent: this changes something, so offer it with propose_work/);
  });

  it("a replayed ask in the same request shares one send; a new request asks again", async () => {
    let finish!: (value: Posted) => void;
    const { engine, posts } = await started({ "/messages": () => new Promise((resolve) => { finish = resolve; }) });
    engine().events.heard("When do the eval loops finish?");
    engine().events.answering();
    engine().events.toolCall([{ id: "t1", name: "ask", args: { question: "When do the eval loops finish?" } }]);
    engine().events.toolCall([{ id: "t2", name: "ask", args: { question: "when do the eval loops finish" } }]);
    await flush();
    finish({ status: 202, data: { ok: true } });
    await flush();
    expect(messagesOf(posts)).toHaveLength(1);
    expect(engine().results).toEqual([{ id: "t1", result: "sent" }, { id: "t2", result: "sent" }]);
    engine().events.heard("Ask again please.");
    engine().events.answering();
    engine().events.toolCall([{ id: "t3", name: "ask", args: { question: "When do the eval loops finish?" } }]);
    await flush();
    finish({ status: 202, data: { ok: true } });
    await flush();
    expect(messagesOf(posts)).toHaveLength(2);
  });

  it("an open card makes an ask not needed", async () => {
    const { call, engine, posts } = await started();
    call.observe({ busy: false, messages: [cardRow("q1")] });
    engine().events.toolCall([{ id: "t1", name: "ask", args: { question: "When is the restart?" } }]);
    await flush();
    expect(messagesOf(posts)).toEqual([]);
    expect(engine().results[0]?.result).toMatch(/^not needed/);
  });
});

describe("VOICE-SEND: receipts and retries", () => {
  it.each([
    [{ ok: true, cancelled: true }, "not sent: cancelled"],
    [{ ok: true, dispatchFailed: true, error: "context preparation failed" }, "not sent: context preparation failed"],
  ])("a negative 202 is never sent: %j", async (data, result) => {
    const { call, engine, posts } = await started({ "/messages": { status: 202, data } });
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Check the build." } }]);
    await call.answer(true);
    await flush();
    expect(engine().results).toEqual([{ id: "t1", result }]);
    expect(call.state().status).toBe("listening");
    expect(linesOf(posts)).toEqual([`Not sent: Check the build. (${result.slice("not sent: ".length)})`]);
  });

  it("a 409 is not replayed", async () => {
    const { call, engine, posts } = await started({ "/messages": { status: 409, data: { error: "the bot switched tasks before it could receive the message" } } });
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Check the build." } }]);
    await call.answer(true);
    expect(messagesOf(posts)).toHaveLength(1);
    expect(engine().results).toEqual([{ id: "t1", result: "not sent: the bot switched tasks before it could receive the message" }]);
  });

  it("a lost receipt retries once with the same sendId in the original task", async () => {
    vi.useFakeTimers();
    let tries = 0;
    const { call, engine, posts } = await started({ "/messages": async () => { tries += 1; if (tries === 1) throw new Error("network down"); return { status: 202, data: { ok: true } }; } });
    call.observe({ busy: false, messages: [], threadId: "task-1" });
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Check the build." } }]);
    const answered = call.answer(true);
    call.observe({ busy: false, messages: [], threadId: "task-2" });
    await vi.advanceTimersByTimeAsync(1_500);
    await answered;
    expect(messagesOf(posts).map((p) => p.body)).toEqual([
      { text: "Check the build.", sendId: "send-1", threadId: "task-1", call: { id: "c-0123456789ab", order: true } },
      { text: "Check the build.", sendId: "send-1", threadId: "task-1", call: { id: "c-0123456789ab", order: true } },
    ]);
    expect(engine().results).toEqual([{ id: "t1", result: "sent" }]);
  });

  it("a retried ask counts as an ask retry, not an order retry", async () => {
    vi.useFakeTimers();
    let tries = 0;
    const { call, engine, posts } = await started({ "/messages": async () => { tries += 1; if (tries === 1) throw new Error("network down"); return { status: 202, data: { ok: true } }; } });
    engine().events.toolCall([{ id: "t1", name: "ask", args: { question: "Does voice use Opus tokens?" } }]);
    await vi.advanceTimersByTimeAsync(1_500);
    call.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(posts.find((p) => p.path.endsWith("/call/end"))?.body.stats).toMatchObject({ orders: { retried: 0 }, asks: { sent: 1, retried: 1 } });
  });

  it.each([
    ["already sent", "Check the build.", "Sent: Check the build."],
    ["already sent", "빌드 확인해 줘.", "Sent: 빌드 확인해 줘."],
    ["already proposed, waiting for their answer", "Check the build.", "Waiting for their answer: Check the build."],
    ["already proposed, waiting for their answer", "빌드 확인해 줘.", "Waiting for their answer: 빌드 확인해 줘."],
  ])("a late %s result never reads as not sent: %s", (result, subject, line) => {
    expect(told(result, subject)).toBe(line);
  });

  it("two failed tries say not confirmed, aloud and in a line", async () => {
    vi.useFakeTimers();
    const { call, engine, posts } = await started({ "/messages": { status: 503, data: { error: "server down" } } });
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Check the build." } }]);
    const answered = call.answer(true);
    await vi.advanceTimersByTimeAsync(1_500);
    await answered;
    expect(messagesOf(posts)).toHaveLength(2);
    expect(engine().results).toEqual([{ id: "t1", result: "not confirmed: server down" }]);
    expect(linesOf(posts)).toEqual(["Not confirmed: Check the build. (server down)"]);
  });

  it("the heard line is saved before the send that it asked for", async () => {
    let save!: () => void;
    const { engine, posts } = await started({ "/call/lines": () => new Promise((resolve) => { save = () => resolve({ status: 200, data: {} }); }) });
    engine().events.heard("Does voice use Opus tokens?");
    engine().events.answering();
    engine().events.toolCall([{ id: "t1", name: "ask", args: { question: "Does voice use Opus tokens?" } }]);
    await flush();
    expect(messagesOf(posts)).toEqual([]);
    save();
    await flush();
    await flush();
    expect(messagesOf(posts)).toHaveLength(1);
  });
});

describe("VOICE-SEND: promise guard", () => {
  it.each([
    ["I am running late.", false],
    ["좀 늦을 것 같아요.", false],
    ["I'm not sure I heard you. Could you repeat?", false],
    ["잘 못 들었어요. 다시 말씀해 주시겠어요?", false],
    ["I don't have a preferred name.", false],
    ["저는 따로 정한 이름이 없어요.", false],
    ["잘 모르겠어요. 다시 말씀해 주세요.", false],
    ["I don't know. Could you say that again?", false],
    ["실패할 수 없는 일은 없어요.", false],
    ["Nothing is impossible.", false],
    ["I'll check that now. Let me know if you need anything else.", true],
    ["바로 확인해 볼게요. 더 필요하시면 말씀해 주세요.", true],
    ["I've checked the build.", true],
    ["빌드 확인했어요.", true],
    ["I already added it to your list.", true],
    ["이미 목록에 추가했어요.", true],
    ["목록에 추가했어요. 원하시면 더 알려드릴게요.", true],
    ["I added it to your list. If you want, I can tell you more.", true],
    ["그렇게 진행할게요.", true],
    ["I'll go ahead with that.", true],
    ["I can't check that. Nothing was sent.", false],
    ["확인할 수 없어요. 아무것도 보내지 않았어요.", false],
    ["I cannot directly open folders.", true],
    ["폴더를 직접 열 수 없어요.", true],
    ["I'm not entirely sure.", true],
    ["Want me to open your Desktop folder?", false],
  ])("%s -> nudge %s", async (said, flagged) => {
    const { engine } = await started();
    turn(engine(), "Can you check the build?", said);
    expect(nudges(engine())).toHaveLength(flagged ? 1 : 0);
  });

  it("honest failure is terminal for its request, a new request is guarded again", async () => {
    const { engine } = await started();
    turn(engine(), "Can you check the build?", "I'll check that.");
    turn(engine(), "", "I can't check that. Nothing was sent.");
    turn(engine(), "", "I'll check that.");
    expect(nudges(engine())).toHaveLength(1);
    turn(engine(), "And the tests?", "I'll check the tests.");
    expect(nudges(engine())).toHaveLength(2);
  });

  it("nudges once per request, three per call, then leaves a Not sent line", async () => {
    const { call, engine, posts } = await started();
    for (const ask of ["Check A?", "Check B?", "Check C?", "Check D?"]) {
      turn(engine(), ask, "I'll check that.");
      turn(engine(), "", "I'll check that.");
    }
    expect(nudges(engine())).toHaveLength(3);
    call.end();
    await flush();
    expect(linesOf(posts)).toContain("Not sent: Check D?");
  });

  it("only an accepted outcome accounts for the request", async () => {
    const { call, engine } = await started();
    engine().events.heard("Can you open the Orbit folder?");
    engine().events.answering();
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Open the Orbit folder." } }]);
    engine().events.said("Want me to open the Orbit folder?");
    engine().events.turnDone();
    expect(nudges(engine())).toEqual([]);
    await call.answer(false);
    turn(engine(), "", "I'll open it anyway.");
    expect(nudges(engine())).toHaveLength(1);
  });

  it("On it while the order still waits says it was not sent", async () => {
    const { engine } = await started();
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Open the Orbit folder." } }]);
    turn(engine(), "Hmm, maybe.", "On it.");
    expect(engine().texts.at(-1)).toBe(`[Wink] Not sent yet: they have not said yes to "Open the Orbit folder.". Ask them again.`);
  });

  it("a relayed result turn is not guarded", async () => {
    const { call, engine } = await started();
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Check the build." } }]);
    await call.answer(true);
    call.observe({ busy: false, messages: [orderRow("o", "Check the build."), botRow("r", "I checked the build, it is red.")] });
    await flush();
    turn(engine(), "", "I've checked the build, it is red.");
    expect(nudges(engine())).toEqual([]);
  });
});

describe("VOICE-SEND: cards", () => {
  it("routes a spoken answer only after the card notice played", async () => {
    const { call, engine, posts } = await started();
    call.observe({ busy: false, messages: [cardRow("q1")] });
    expect(engine().texts.at(-1)).toBe("[Wink] Nova asks: Restart at 8:15 PM? Options: Yes; No. Read it out with the options, then wait for their answer.");
    engine().events.heard("Hello?");
    engine().events.answering();
    expect(messagesOf(posts)).toEqual([]);
    engine().events.said("Nova asks if 8:15 works.");
    engine().events.turnDone();
    engine().events.heard("Yes.");
    engine().events.answering();
    await flush();
    expect(messagesOf(posts).map((p) => p.body.text)).toEqual(["Yes."]);
    expect(linesOf(posts)).toEqual(["Hello?", "Nova asks if 8:15 works."]);
  });

  it("waits for the audio to drain before the card counts as played", async () => {
    const audio = { ...fakeAudio(), playing: false };
    const { call, engine, posts } = await started({}, audio);
    call.observe({ busy: false, messages: [cardRow("q1")] });
    audio.onStart();
    audio.playing = true;
    engine().events.turnDone();
    engine().events.heard("Yes.");
    engine().events.answering();
    expect(messagesOf(posts)).toEqual([]);
    audio.playing = false;
    audio.onIdle();
    engine().events.heard("Yes.");
    engine().events.answering();
    await flush();
    expect(messagesOf(posts)).toHaveLength(1);
  });

  it("relays a card already open when the call started", async () => {
    const { call, engine } = await started();
    call.observe({ busy: false, messages: [cardRow("q1", 10)] });
    expect(engine().texts.at(-1)).toBe("[Wink] Nova asks: Restart at 8:15 PM? Options: Yes; No. Read it out with the options, then wait for their answer.");
  });

  it("a failed answer rearms the card and says so", async () => {
    const { call, engine, posts } = await started({ "/messages": { status: 409, data: { error: "busy" } } });
    call.observe({ busy: false, messages: [cardRow("q1")] });
    turn(engine(), "", "Nova asks if 8:15 works.");
    engine().events.heard("Yes.");
    engine().events.answering();
    await flush();
    call.observe({ busy: false, messages: [cardRow("q1")] });
    engine().events.turnDone();
    expect(engine().texts.at(-1)).toBe(`[Wink] Not sent: their answer "Yes." did not reach Nova (busy). Say so plainly and ask them to answer again.`);
    engine().events.heard("Yes.");
    engine().events.answering();
    await flush();
    expect(messagesOf(posts)).toHaveLength(2);
  });

  it("drops a waiting card notice once the card is answered by typing", async () => {
    const audio = { ...fakeAudio(), playing: false };
    const { call, engine } = await started({}, audio);
    audio.onStart();
    audio.playing = true;
    call.observe({ busy: false, messages: [cardRow("q1")] });
    call.observe({ busy: false, messages: [cardRow("q1"), userRow("u", "Yes, 8:15.")] });
    audio.playing = false;
    engine().events.turnDone();
    audio.onIdle();
    expect(engine().texts.some((t) => t.includes("Nova asks"))).toBe(false);
  });
});

describe("VOICE-SEND: replies", () => {
  it("D12 speaks a quick answer to this call's ask, busy or idle, once", async () => {
    const { call, engine } = await started();
    const rows = [askRow("a1", "Does voice use Opus tokens?", { quick: { state: "asked" } }), botRow("r1", "No, talking is all Gemini.", { quick: { state: "answer", askId: "a1" } })];
    call.observe({ busy: true, messages: rows });
    call.observe({ busy: false, messages: rows });
    await flush();
    expect(engine().texts.filter((t) => t.includes("talking is all Gemini"))).toEqual(["[Wink] Nova replied: No, talking is all Gemini."]);
  });

  it("never speaks a quick answer to a typed or another call's ask", async () => {
    const { call, engine } = await started();
    call.observe({ busy: true, messages: [
      userRow("a1", "Typed ask?", { quick: { state: "asked" } }), botRow("r1", "Typed answer.", { quick: { state: "answer", askId: "a1" } }),
      userRow("a2", "Other call?", { call: { id: "c-ffffffffffff", ask: true }, quick: { state: "asked" } }), botRow("r2", "Other answer.", { quick: { state: "answer", askId: "a2" } }),
    ] });
    await flush();
    expect(engine().texts.some((t) => t.includes("replied"))).toBe(false);
  });

  it("settles an ask once when the quick helper hands it to the bot", async () => {
    const { call, engine } = await started({ "/messages": { status: 202, data: { ok: true, quick: true } } });
    engine().events.toolCall([{ id: "t1", name: "ask", args: { question: "What changed?" } }]);
    await flush();
    expect(call.state().status).toBe("working");
    const rows = [askRow("a1", "What changed?", { steered: true, quick: { state: "handoff" } }), botRow("r1", "Two files.")];
    call.observe({ busy: false, messages: rows });
    call.observe({ busy: false, messages: rows });
    await flush();
    expect(engine().texts.filter((t) => t.includes("replied"))).toEqual(["[Wink] Nova replied: Two files."]);
    expect(call.state().status).toBe("listening");
  });

  it("a peer row is not a human request boundary", async () => {
    const { call, engine } = await started();
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Check the build." } }]);
    await call.answer(true);
    const peer = userRow("p1", "A peer update.", { from: { botId: "b2", name: "Peer", color: "white" } } as Partial<Message>);
    call.observe({ busy: false, messages: [orderRow("o1", "Check the build."), peer, botRow("r1", "The build is red.")] });
    await flush();
    expect(engine().texts.filter((t) => t.includes("replied"))).toEqual(["[Wink] Nova replied: The build is red."]);
    expect(engine().contexts).toEqual([]);
  });

  it("holds a report while the voice is generating before its first audio", async () => {
    const { call, engine } = await started();
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Check the build." } }]);
    await call.answer(true);
    engine().events.answering();
    call.observe({ busy: false, messages: [orderRow("o1", "Check the build."), botRow("r1", "Red.")] });
    await flush();
    expect(engine().texts.some((t) => t.includes("replied"))).toBe(false);
    engine().events.turnDone();
    expect(engine().texts.at(-1)).toBe("[Wink] Nova replied: Red.");
  });

  it("holds a report while the person is talking", async () => {
    const { call, engine } = await started();
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Check the build." } }]);
    await call.answer(true);
    engine().events.heard("Also can you");
    call.observe({ busy: false, messages: [orderRow("o1", "Check the build."), botRow("r1", "Red.")] });
    await flush();
    expect(engine().texts.some((t) => t.includes("replied"))).toBe(false);
  });

  it("sends the done correction through the queue, after the voice stops", async () => {
    const { call, engine } = await started({ "/messages": { status: 202, data: { ok: true } } });
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Fix it." } }]);
    await call.answer(true);
    engine().events.answering();
    engine().events.said("All done.");
    expect(engine().texts.some((t) => t.startsWith("[Wink] Not done yet"))).toBe(false);
    engine().events.turnDone();
    expect(engine().texts.at(-1)).toBe("[Wink] Not done yet: Nova is still working.");
  });
});

describe("VOICE-SEND: reconnect", () => {
  it("a result in the reconnect window is told on the new session", async () => {
    let finish!: (value: Posted) => void;
    let reconnect!: (value: Posted) => void;
    const token = { status: 200, data: { callId: "c-0123456789ab", url: "wss://x", token: "t", model: "m" } };
    let tokens = 0;
    const { call, engines } = await started({
      "/messages": () => new Promise((resolve) => { finish = resolve; }),
      "/call/token": () => (tokens += 1) === 1 ? Promise.resolve(token) : new Promise((resolve) => { reconnect = resolve; }),
    });
    engines[0]!.events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Check the build." } }]);
    const answered = call.answer(true);
    engines[0]!.events.resumable("h1");
    engines[0]!.events.goAway();
    await flush();
    finish({ status: 202, data: { ok: true } });
    await answered;
    reconnect(token);
    await flush();
    engines[1]!.events.ready();
    expect(engines.flatMap((engine) => engine.results)).toEqual([]);
    expect(engines[1]!.texts).toEqual(["[Wink] Sent: Check the build."]);
  });

  it("a result after reconnect for an old tool id goes as a [Wink] line", async () => {
    const { call, engines, engine } = await started();
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Check the build." } }]);
    engine().events.resumable("h1");
    engine().events.goAway();
    await flush();
    engine().events.ready();
    await call.answer(true);
    expect(engines.flatMap((e) => e.results)).toEqual([]);
    expect(engine().texts).toEqual(["[Wink] Sent: Check the build."]);
  });

  it("a reconnect mid-voice does not stall a held reply", async () => {
    const audio = { ...fakeAudio(), playing: false };
    const { call, engine } = await started({}, audio);
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Check the build." } }]);
    await call.answer(true);
    audio.onStart();
    audio.playing = true;
    call.observe({ busy: false, messages: [orderRow("o1", "Check the build."), botRow("r1", "Red.")] });
    await flush();
    engine().events.resumable("h1");
    engine().events.goAway();
    await flush();
    engine().events.ready();
    audio.playing = false;
    audio.onIdle();
    expect(engine().texts).toEqual(["[Wink] Nova replied: Red."]);
  });

  it("a reconnect while generating does not stall a held reply", async () => {
    const { call, engine } = await started();
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Check the build." } }]);
    await call.answer(true);
    engine().events.answering();
    call.observe({ busy: false, messages: [orderRow("o1", "Check the build."), botRow("r1", "Red.")] });
    await flush();
    engine().events.resumable("h1");
    engine().events.goAway();
    await flush();
    engine().events.ready();
    expect(engine().texts).toEqual(["[Wink] Nova replied: Red."]);
  });
});

const notices = (engine: FakeEngine) => engine.texts.filter((t) => t.startsWith("[Wink] Nova asks:"));
const koCard = (id: string) => ({ id, role: "bot", kind: "options", at: 2_000, card: { title: "질문이 있어요", subtitle: "8시 15분에 재시작할까요?", options: ["네, 8시 15분", "아니요, 새벽 1시"], askUser: true } }) as Message;
const paneNote = (id: string, report: string) => ({ id, role: "user", kind: "note", at: 2_000, text: `[pane aaaaaaaa] [BUILD | opus | high] from Nova (b1): ${report} branch=x sha=1 dirty=0\nbody` }) as Message;
const statusLines = (engine: FakeEngine) => engine.contexts.filter((t) => t.startsWith("[Wink] Status now"));

describe("VOICE-KNOWS: cards aloud", () => {
  it.each([
    ["en", cardRow("q1"), "[Wink] Nova asks: Restart at 8:15 PM? Options: Yes; No. Read it out with the options, then wait for their answer."],
    ["ko", koCard("q1"), "[Wink] Nova asks: 8시 15분에 재시작할까요? Options: 네, 8시 15분; 아니요, 새벽 1시. Read it out with the options, then wait for their answer."],
  ])("D10 speaks the card's question and options, and routes the answer only after it played (%s)", async (_lang, card, notice) => {
    const audio = { ...fakeAudio(), playing: false };
    const { call, engine, posts } = await started({}, audio);
    call.observe({ busy: false, messages: [card] });
    expect(engine().texts.at(-1)).toBe(notice);
    audio.onStart();
    audio.playing = true;
    engine().events.turnDone();
    engine().events.heard("Hmm.");
    engine().events.answering();
    expect(messagesOf(posts)).toEqual([]);
    audio.playing = false;
    audio.onIdle();
    engine().events.heard("Yes.");
    engine().events.answering();
    await flush();
    expect(messagesOf(posts).map((p) => p.body)).toEqual([{ text: "Yes.", sendId: "send-1", call: { id: "c-0123456789ab", ask: true } }]);
  });

  it("a card with no options still reads its question", async () => {
    const { call, engine } = await started();
    call.observe({ busy: false, messages: [{ id: "q1", role: "bot", kind: "options", at: 2_000, card: { title: "Your bot has a question", subtitle: "", options: [], askUser: true } } as Message] });
    expect(engine().texts.at(-1)).toBe("[Wink] Nova asks: Your bot has a question Read it out, then wait for their answer.");
  });

  it("clips each long option the way STATUS does", async () => {
    const { call, engine } = await started();
    call.observe({ busy: false, messages: [{ id: "q1", role: "bot", kind: "options", at: 2_000, card: { title: "q", subtitle: "Which one?", options: ["가".repeat(200), "Short"], askUser: true } } as Message] });
    expect(engine().texts.at(-1)).toBe(`[Wink] Nova asks: Which one? Options: ${"가".repeat(79)}…; Short. Read it out with the options, then wait for their answer.`);
  });

  it("a superseded card is never read; the newer one is, and takes the answer", async () => {
    const audio = { ...fakeAudio(), playing: false };
    const { call, engine, posts } = await started({}, audio);
    audio.onStart();
    audio.playing = true;
    call.observe({ busy: false, messages: [cardRow("q1")] });
    const newer = { ...koCard("q2"), at: 2_100 } as Message;
    call.observe({ busy: false, messages: [cardRow("q1"), newer] });
    audio.playing = false;
    engine().events.turnDone();
    audio.onIdle();
    expect(notices(engine())).toEqual([expect.stringContaining("8시 15분에 재시작할까요?")]);
    engine().events.turnDone();
    engine().events.heard("네.");
    engine().events.answering();
    await flush();
    expect(messagesOf(posts).map((p) => p.body.text)).toEqual(["네."]);
  });

  it("an interrupted card is read again, and a line said over it is not its answer", async () => {
    const { call, engine, posts } = await started();
    call.observe({ busy: false, messages: [cardRow("q1")] });
    engine().events.interrupted();
    engine().events.heard("Wait, what?");
    engine().events.answering();
    engine().events.said("Sorry.");
    engine().events.turnDone();
    expect(notices(engine())).toHaveLength(2);
    engine().events.turnDone();
    engine().events.heard("Yes.");
    engine().events.answering();
    await flush();
    expect(messagesOf(posts).map((p) => p.body.text)).toEqual(["Yes."]);
    expect(linesOf(posts)).toContain("Wait, what?");
  });

  it("an old card from before the call is read with its question", async () => {
    const { call, engine } = await started();
    call.observe({ busy: false, messages: [{ ...koCard("q1"), at: 10 } as Message] });
    expect(notices(engine())).toEqual([expect.stringContaining("8시 15분에 재시작할까요?")]);
  });
});

describe("VOICE-KNOWS: status", () => {
  it("tells a worker report as silent context, never on the first look, newest kept through a 30 s trailing flush", async () => {
    const { call, engine } = await started();
    call.observe({ busy: false, messages: [paneNote("n0", "BLOCKED BUILD")] });
    expect(statusLines(engine())).toEqual([]);
    vi.useFakeTimers();
    call.observe({ busy: false, messages: [paneNote("n0", "BLOCKED BUILD"), paneNote("n1", "FAIL BUILD")] });
    expect(statusLines(engine())).toEqual(["[Wink] Status now. Context only, do not read it out.\nNova is idle.\nWorkers, newest first: BUILD reported FAILED."]);
    call.observe({ busy: true, messages: [paneNote("n1", "FAIL BUILD"), userRow("u1", "Rerun it.")] });
    call.observe({ busy: false, messages: [paneNote("n1", "FAIL BUILD"), userRow("u1", "Rerun it."), paneNote("n2", "DONE BUILD")] });
    expect(statusLines(engine())).toHaveLength(1);
    vi.advanceTimersByTime(30_000);
    expect(statusLines(engine()).at(-1)).toBe("[Wink] Status now. Context only, do not read it out.\nNova is idle.\nWorkers, newest first: BUILD reported DONE.");
    expect(statusLines(engine())).toHaveLength(2);
    vi.advanceTimersByTime(60_000);
    call.observe({ busy: false, messages: [paneNote("n1", "FAIL BUILD"), userRow("u1", "Rerun it."), paneNote("n2", "DONE BUILD")] });
    expect(statusLines(engine())).toHaveLength(2);
    expect(engine().texts.some((t) => t.includes("reported"))).toBe(false);
  });

  it("a trailing status waits for the voice to be quiet", async () => {
    const { call, engine } = await started();
    call.observe({ busy: false, messages: [] });
    engine().events.answering();
    call.observe({ busy: false, messages: [paneNote("n1", "DONE BUILD")] });
    expect(statusLines(engine())).toEqual([]);
    engine().events.turnDone();
    expect(statusLines(engine())).toHaveLength(1);
  });

  it("stops the trailing flush when the call ends", async () => {
    const { call, engine } = await started();
    call.observe({ busy: false, messages: [] });
    vi.useFakeTimers();
    call.observe({ busy: false, messages: [paneNote("n1", "FAIL BUILD")] });
    call.observe({ busy: false, messages: [paneNote("n2", "DONE BUILD")] });
    call.end();
    vi.advanceTimersByTime(30_000);
    expect(statusLines(engine())).toHaveLength(1);
  });
});

describe("VOICE-KNOWS: answers and stats", () => {
  it("D12 a busy bot's quick answer to a spoken ask is spoken and counted answered with its time", async () => {
    const { call, engine, posts } = await started({ "/messages": { status: 202, data: { ok: true, quick: true } } });
    engine().events.heard("Does voice use Opus tokens?");
    engine().events.answering();
    engine().events.toolCall([{ id: "t1", name: "ask", args: { question: "Does voice use Opus tokens?" } }]);
    engine().events.turnDone();
    await flush();
    const rows = [askRow("a1", "Does voice use Opus tokens?", { sendId: "send-1", quick: { state: "asked" } }), botRow("r1", "No, talking is all Gemini.", { at: 11_000, quick: { state: "answer", askId: "a1" } })];
    call.observe({ busy: true, messages: rows });
    call.observe({ busy: true, messages: rows });
    await flush();
    expect(engine().texts.filter((t) => t.includes("talking is all Gemini"))).toEqual(["[Wink] Nova replied: No, talking is all Gemini."]);
    call.end();
    await flush();
    const stats = posts.find((p) => p.path.endsWith("/call/end"))!.body.stats;
    expect(stats.asks).toEqual({ sent: 1, retried: 0, answered: 1, ms: { p50: 9_000, p90: 9_000 } });
  });

  it("a card answer or a typed ask is not counted as a spoken ask", async () => {
    const { call, engine, posts } = await started();
    call.observe({ busy: false, messages: [cardRow("q1")] });
    engine().events.turnDone();
    engine().events.heard("Yes.");
    engine().events.answering();
    await flush();
    call.observe({ busy: false, messages: [askRow("a1", "Yes.", { sendId: "send-1" }), botRow("r1", "Set.", { at: 3_000 })] });
    call.observe({ busy: true, messages: [userRow("t1", "Typed?", { sendId: "send-1", quick: { state: "asked" } }), botRow("r2", "Typed answer.", { quick: { state: "answer", askId: "t1" } })] });
    await flush();
    call.end();
    await flush();
    expect(posts.find((p) => p.path.endsWith("/call/end"))!.body.stats.asks).toEqual({ sent: 0, retried: 0, answered: 0, ms: { p50: null, p90: null } });
  });

  it("counts guard flags by kind and times the acknowledgement of turns that sent", async () => {
    let frame!: (pcm: ArrayBuffer) => void;
    const audio = { ...fakeAudio(), async capture(fn: (pcm: ArrayBuffer) => void) { frame = fn; } };
    const { call, engine, posts } = await started({}, audio);
    const loud = () => frame(new Int16Array([5_000]).buffer);
    loud();
    engine().events.heard("Can you check when the eval loops finish?");
    engine().events.answering();
    audio.onStart();
    engine().events.said("I will check that for you right now.");
    engine().events.turnDone();
    turn(engine(), "", "Sorry about that.");
    turn(engine(), "What is the weather in Seoul?", "I'm not sure.");
    turn(engine(), "", "Okay.");
    turn(engine(), "Open the Orbit folder.", "폴더를 열 수 없어요.");
    turn(engine(), "", "Okay.");
    loud();
    engine().events.heard("Does voice use Opus tokens?");
    engine().events.answering();
    engine().events.toolCall([{ id: "t1", name: "ask", args: { question: "Does voice use Opus tokens?" } }]);
    audio.onStart();
    engine().events.said("Let me check.");
    engine().events.turnDone();
    await flush();
    call.end();
    await flush();
    const stats = posts.find((p) => p.path.endsWith("/call/end"))!.body.stats;
    expect(stats.guard).toEqual({ nudges: 3, failLines: 0, promise: 1, cant: 1, unsure: 1 });
    expect(stats.ttfaMs).toEqual({ p50: 0, p90: 0 });
    expect(stats.ackMs).toEqual({ p50: 0, p90: 0 });
  });

  it("a call with no sends has no acknowledgement time", async () => {
    const { call, posts } = await started();
    call.end();
    await flush();
    expect(posts.find((p) => p.path.endsWith("/call/end"))!.body.stats.ackMs).toEqual({ p50: null, p90: null });
  });

  it("a yes waits for the offer's lines to be saved before the order is sent", async () => {
    const saves: Array<() => void> = [];
    const save = () => { for (const done of saves.splice(0)) done(); };
    const { call, engine, posts } = await started({ "/call/lines": () => new Promise((resolve) => { saves.push(() => resolve({ status: 200, data: {} })); }) });
    turn(engine(), "Can you open the Orbit folder?", "Want me to open it?");
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Open the Orbit folder." } }]);
    engine().events.heard("Yes.");
    engine().events.answering();
    await flush();
    expect(messagesOf(posts)).toEqual([]);
    save();
    await flush();
    await flush();
    expect(messagesOf(posts).map((p) => p.body.text)).toEqual(["Open the Orbit folder."]);
    expect(call.state().status).toBe("working");
  });
});
