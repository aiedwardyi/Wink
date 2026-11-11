import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@/state/store-types";
import { LiveCall, spokenText, type CallAudioPort, type Posted } from "./controller";
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

  it("expires an order after 45 s, replaces one on a new proposal, drops it on cancel", async () => {
    vi.useFakeTimers();
    const { call, engine } = await started();
    engine().events.toolCall([{ id: "t1", name: "propose_work", args: { order: "A" } }]);
    engine().events.toolCall([{ id: "t2", name: "propose_work", args: { order: "B" } }]);
    expect(engine().results).toEqual([{ id: "t1", result: "declined" }]);
    vi.advanceTimersByTime(45_000);
    expect(engine().results.at(-1)).toEqual({ id: "t2", result: "expired" });
    engine().events.toolCall([{ id: "t3", name: "propose_work", args: { order: "C" } }]);
    engine().events.toolCancel(["t3"]);
    expect(call.state().pending).toBeUndefined();
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
    expect(engine().contexts).toEqual([]);
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
    const rows = [ask, userRow("a", "Yeah, that's better.", { call: { id: "c-0123456789ab", ask: true } }), botRow("r", "Restart set for 8:15 PM.")];
    call.observe({ busy: false, messages: rows });
    await flush();
    expect(engine().texts.filter((t) => t.includes("replied"))).toEqual(["[Wink] Nova replied: Restart set for 8:15 PM."]);
  });

  it("a failed spoken answer still lands as a call line", async () => {
    const { call, engine, posts } = await started({ "/messages": { status: 500, data: { error: "down" } } });
    call.observe({ busy: false, messages: [{ id: "ask", role: "bot", kind: "options", at: 2_000, card: { title: "q", subtitle: "8:15?", options: [], askUser: true } } as Message] });
    engine().events.heard("Yeah, that's better.");
    engine().events.answering();
    await flush();
    expect(posts.filter((p) => p.path.endsWith("/call/lines")).map((p) => p.body.lines[0].text)).toEqual(["Yeah, that's better."]);
  });

  it("the bot's reply to a spoken answer can offer new work", async () => {
    const { call, engine } = await started();
    const ask = { id: "ask", role: "bot", kind: "options", at: 2_000, card: { title: "q", subtitle: "8:15?", options: [], askUser: true } } as Message;
    call.observe({ busy: false, messages: [ask] });
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
