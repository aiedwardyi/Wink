// The voice audit's findings by id (T1, O1, O2, ...), replayed. Fake engine and fake audio port only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LiveCall, type CallAudioPort, type Posted } from "./controller";
import type { LiveEngine, LiveEvents } from "./engine";
import { asksAboutWork, claimOf, ordersChange } from "./guard";

const CALL = "c-0123456789ab";

// Like Gemini Live, context only goes on the wire with the next text or tool result.
class FakeEngine implements LiveEngine {
  events!: LiveEvents;
  texts: string[] = [];
  contexts: string[] = [];
  wire: string[] = [];
  private waiting: string[] = [];
  connect(_session: unknown, events: LiveEvents) { this.events = events; }
  sendAudio() {}
  audioPaused() {}
  sendText(text: string) {
    this.texts.push(text);
    this.wire.push([...this.waiting.splice(0), text].join("\n"));
  }
  sendContext(text: string) {
    this.contexts.push(text);
    this.waiting.push(text);
  }
  sendToolResult(_ids: string[], _name: string, result: unknown) { this.wire.push([...this.waiting.splice(0), String(result)].join("\n")); }
  close() {}
}

function fakeAudio(): CallAudioPort & { hiss(): void } {
  let frame: (pcm: ArrayBuffer) => void = () => {};
  return {
    playing: false,
    async capture(onFrame) { frame = onFrame; },
    async heal() { return true; },
    stopMic() {},
    play() {},
    flush() {},
    close() {},
    boop() {},
    heardShare: () => 1,
    micLevel: () => 0.2,
    onIdle: () => {},
    onStart: () => {},
    hiss() { frame(new Int16Array(640).fill(20).buffer); },
  };
}

const ACCEPTED: Posted = { status: 202, data: { ok: true } };

/** Live past its greeting, with the mic quiet. `early` lands in chat before the hello. */
async function live(early?: unknown[]) {
  let t = 0;
  const audio = fakeAudio();
  const engines: FakeEngine[] = [];
  const posts: Array<{ path: string; body: any }> = [];
  const call = new LiveCall({
    botId: "b1",
    botName: "Nova",
    device: "phone",
    engine: () => { const engine = new FakeEngine(); engines.push(engine); return engine; },
    audio,
    now: () => t,
    post: async (path, body) => {
      posts.push({ path, body });
      if (path.endsWith("/messages")) return ACCEPTED;
      if (path.endsWith("/call/token")) return { status: 200, data: { callId: CALL, url: "wss://x", token: "t", model: "m", voice: "Aoede" } };
      return { status: 200, data: {} };
    },
  });
  const tick = async (ms: number) => {
    t += ms;
    await vi.advanceTimersByTimeAsync(ms);
  };
  const wait = async (ms: number) => {
    for (let left = ms; left > 0; left -= 1_000) {
      audio.hiss();
      await tick(Math.min(1_000, left));
    }
  };
  await call.start();
  engines[0]!.events.ready();
  if (early) {
    call.observe({ busy: false, messages: early as never });
    engines[0]!.events.answering();
    engines[0]!.events.said("Hey, I'm here.");
  }
  engines[0]!.events.turnDone();
  await wait(5_000);
  return { call, engines, engine: () => engines.at(-1)!, posts, tick, wait };
}

const sent = (posts: Array<{ path: string; body: any }>) => posts.filter((p) => p.path === "/api/bots/b1/messages").map((p) => p.body.text);
const lines = (posts: Array<{ path: string; body: any }>) => posts.filter((p) => p.path.endsWith("/call/lines")).flatMap((p) => p.body.lines.map((line: { text: string }) => line.text));
const turn = (engine: FakeEngine, heard: string, said: string) => {
  engine.events.heard(heard);
  engine.events.answering();
  engine.events.said(said);
  engine.events.turnDone();
};
const reply = (id: string, text: string, at: number) => ({ id, role: "bot", kind: "text", text, at });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("crypto", { randomUUID: () => "send-1" });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("T1 what changed mid-call reaches the voice", () => {
  it("a reply that lands while the voice answers rides its tool result", async () => {
    const { call, engine, tick } = await live();
    engine().events.heard("What did it say?");
    engine().events.answering();
    call.observe({ busy: false, messages: [reply("r1", "The token expired.", 9_000)] as never });
    engine().events.toolCall([{ id: "a1", name: "ask", args: { question: "What did it say?" } }]);
    await tick(10);
    expect(engine().wire.at(-1)).toContain("The token expired.");
    expect(engine().wire.at(-1)).toContain("sent");
  });

  it("context a dropped socket never sent goes to the next one", async () => {
    const { call, engines, engine, tick, wait } = await live();
    call.observe({ busy: false, messages: [reply("r1", "The token expired.", 9_000)] as never });
    expect(engines[0]!.contexts).toHaveLength(1);
    expect(engines[0]!.wire.join("\n")).not.toContain("The token expired.");
    engines[0]!.events.resumable("h1");
    engines[0]!.events.closed(1006, "");
    await tick(100);
    engine().events.ready();
    await wait(2_000);
    expect(engines).toHaveLength(2);
    expect(engine().contexts.join("\n")).toContain("The token expired.");
  });

  it("context already on the wire is not sent again after a reconnect", async () => {
    const { call, engines, engine, tick, wait } = await live();
    engine().events.heard("What did it say?");
    engine().events.answering();
    call.observe({ busy: false, messages: [reply("r1", "The token expired.", 9_000)] as never });
    engine().events.toolCall([{ id: "a1", name: "ask", args: { question: "What did it say?" } }]);
    await tick(10);
    engine().events.turnDone();
    engines[0]!.events.resumable("h1");
    engines[0]!.events.closed(1006, "");
    await tick(100);
    engine().events.ready();
    await wait(2_000);
    expect(engine().contexts).toEqual([]);
  });
});

const UPDATE = "Update: that just changed";
const updates = (engine: FakeEngine) => engine.wire.filter((frame) => frame.includes(UPDATE));

describe("T1 an answer that missed a reply is corrected once", () => {
  it("a plain answer about the work, with a reply unseen, gets one Update line carrying it", async () => {
    const { call, engine, wait } = await live();
    call.observe({ busy: false, messages: [reply("r1", "The deploy finished.", 9_000)] as never });
    turn(engine(), "Did the deploy finish?", "Not yet, it's still running.");
    await wait(3_000);
    expect(updates(engine())).toHaveLength(1);
    expect(updates(engine())[0]).toContain("The deploy finished.");
    engine().events.answering();
    engine().events.said("Update: that just changed, the deploy finished.");
    engine().events.turnDone();
    turn(engine(), "Is it done?", "Yes, it finished.");
    await wait(3_000);
    expect(updates(engine())).toHaveLength(1);
  });

  it("the hello stays silent, and so does small talk after it", async () => {
    const { engine, wait } = await live([reply("r1", "The deploy finished.", 0)]);
    expect(engine().texts).toHaveLength(1);
    turn(engine(), "Hey, what's a good name for a cat?", "Maybe Miso.");
    await wait(3_000);
    expect(engine().texts).toHaveLength(1);
    expect(updates(engine())).toEqual([]);
    expect(engine().contexts.join("\n")).toContain("The deploy finished.");
  });

  it("a reply the voice saw with a tool result needs no Update", async () => {
    const { call, engine, tick, wait } = await live();
    engine().events.heard("Did the deploy finish?");
    engine().events.answering();
    call.observe({ busy: false, messages: [reply("r1", "The deploy finished.", 9_000)] as never });
    engine().events.toolCall([{ id: "a1", name: "ask", args: { question: "Did the deploy finish?" } }]);
    await tick(10);
    engine().events.said("Yes, it finished.");
    engine().events.turnDone();
    await wait(3_000);
    expect(updates(engine())).toEqual([]);
  });

  it("his line is about the work or it is not", () => {
    const work = ["Did the deploy finish?", "Is it done yet?", "Any update?", "What's the status?", "How's the build going?", "Is Nova still working?", "What did it say?", "배포 끝났어?", "어떻게 됐어?", "지금 뭐 하고 있어?"];
    expect(work.filter((line) => !asksAboutWork(line, "Nova"))).toEqual([]);
    const other = ["Hey, what's a good name for a cat?", "Tell me a joke.", "Thanks.", "오늘 날씨 어때?"];
    expect(other.filter((line) => asksAboutWork(line, "Nova"))).toEqual([]);
  });
});

describe("O1 a promise with nothing behind it is caught, whatever shape the order had", () => {
  it("his line is an order behind a hello, a name or a softener, and as a plain Korean command", () => {
    const orders = ["Hey, open my Desktop folder.", "Just merge it.", "I need you to fix the login bug.", "Nova, restart the server.", "Okay so please delete the old branch.", "배포해", "이거 고쳐", "열어봐", "서버 재시작해."];
    expect(orders.filter((line) => !ordersChange(line, ["Nova", "Jenn"]))).toEqual([]);
    const talk = ["Hey, how's it going?", "Just checking in.", "Nova, are you there?", "Okay, stop.", "So what's open right now?", "좋은 하루 보내", "고쳐도 돼?", "그거 내 꺼"];
    expect(talk.filter((line) => ordersChange(line, ["Nova", "Jenn"]))).toEqual([]);
  });

  it("the voice saying it is doing it is a promise, subject or not", () => {
    const promises = ["Opening it now.", "Sure, merging it now.", "Restarting the server.", "I'll deploy it.", "I'm pushing it.", "Let me delete that.", "지금 배포할게요.", "고칠게요.", "열게요.", "바로 삭제하겠습니다."];
    expect(promises.filter((said) => claimOf(said)?.claim !== "promise")).toEqual([]);
    const plain = ["Opening it, okay?", "Want me to merge it?", "Looking good so far.", "It's a deploy script.", "배포할까요?", "배포는 어제 끝났어요."];
    expect(plain.filter((said) => claimOf(said))).toEqual([]);
  });

  it.each([
    ["Hey, open my Desktop folder.", "Opening it now."],
    ["Just merge it.", "Merging it now."],
    ["I need you to fix the login bug.", "Sure thing."],
    ["Nova, restart the server.", "Restarting the server."],
    ["배포해", "지금 배포할게요."],
    ["이거 고쳐", "네, 고칠게요."],
  ])("%s answered with %s is nudged, and the order still goes at hang-up", async (heard, said) => {
    const { call, engine, posts, tick, wait } = await live();
    turn(engine(), heard, said);
    await wait(3_000);
    expect(engine().texts.filter((text) => text.startsWith("[Wink] Not done"))).toHaveLength(1);
    call.end();
    await tick(1_100);
    expect(sent(posts)).toEqual([heard]);
  });

  it("an order the voice offered with propose_work gets no nudge", async () => {
    const { call, engine, tick, wait } = await live();
    engine().events.heard("Just merge it.");
    engine().events.answering();
    engine().events.said("Merging it, okay?");
    engine().events.toolCall([{ id: "p1", name: "propose_work", args: { order: "Merge it." } }]);
    await tick(10);
    engine().events.turnDone();
    await wait(3_000);
    expect(call.state().pending?.order).toBe("Merge it.");
    expect(engine().texts.filter((text) => text.startsWith("[Wink] Not"))).toEqual([]);
  });
});

describe("O2 a dropped call keeps his words", () => {
  it("an order nothing dealt with shows as not sent, and is not sent", async () => {
    const { call, engine, posts, tick } = await live();
    engine().events.heard("Fix the login bug.");
    engine().events.closed(1006, "");
    await tick(100);
    expect(call.state().status).toBe("failed");
    expect(lines(posts)).toEqual(["Fix the login bug.", "Not sent (call ended): Fix the login bug."]);
    expect(call.state().notice).toEqual({ kind: "notSent", text: "Fix the login bug.", why: "call ended" });
    expect(sent(posts)).toEqual([]);
  });

  it("small talk leaves no line", async () => {
    const { engine, posts, tick } = await live();
    engine().events.heard("Okay, thanks.");
    engine().events.closed(1006, "");
    await tick(100);
    expect(lines(posts)).toEqual(["Okay, thanks."]);
  });
});

describe("O3 an expired offer", () => {
  it("is not sent at hang-up, whatever the voice says about it", async () => {
    const { call, engine, posts, tick, wait } = await live();
    engine().events.heard("Delete the old logs.");
    engine().events.answering();
    engine().events.said("Deleting the old logs, okay?");
    engine().events.toolCall([{ id: "p1", name: "propose_work", args: { order: "Delete the old logs." } }]);
    await tick(10);
    engine().events.turnDone();
    await wait(46_000);
    expect(call.state().pending).toBeUndefined();
    expect(call.state().notice).toEqual({ kind: "notSent", text: "Delete the old logs.", why: "expired" });
    engine().events.answering();
    engine().events.said("That one wasn't sent.");
    engine().events.turnDone();
    call.end();
    await tick(1_100);
    expect(sent(posts)).toEqual([]);
    expect(lines(posts)).toContain("Not sent: Delete the old logs. (expired)");
  });

  it("words said after the offer still go at hang-up", async () => {
    const { call, engine, posts, tick, wait } = await live();
    engine().events.heard("Delete the old logs.");
    engine().events.answering();
    engine().events.toolCall([{ id: "p1", name: "propose_work", args: { order: "Delete the old logs." } }]);
    await tick(10);
    engine().events.turnDone();
    await wait(46_000);
    engine().events.heard("Rename the logo file.");
    call.end();
    await tick(1_100);
    expect(sent(posts)).toEqual(["Rename the logo file."]);
  });
});
