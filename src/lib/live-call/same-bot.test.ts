import { afterEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@/state/store-types";
import { VOICE_OUT, type CallAudioPort, type Posted } from "./controller";
import type { LiveEngine, LiveEvents } from "./engine";
import { SameBotCall } from "./same-bot";

class FakeEngine implements LiveEngine {
  events!: LiveEvents;
  texts: string[] = [];
  frames = 0;
  paused = 0;
  closed = false;
  connect(_session: unknown, events: LiveEvents) { this.events = events; }
  sendAudio() { this.frames += 1; }
  audioPaused() { this.paused += 1; }
  sendText(text: string) { this.texts.push(text); }
  sendContext() {}
  sendToolResult() {}
  close() { this.closed = true; }
}

type FakeAudio = CallAudioPort & { played: number; flushed: number; mic?: (pcm: ArrayBuffer) => void };
function fakeAudio(): FakeAudio {
  return {
    played: 0,
    flushed: 0,
    playing: false,
    async capture(onFrame) { this.mic = onFrame; },
    stopMic() {},
    async heal() { return true; },
    play() { this.played += 1; if (!this.playing) { this.playing = true; this.onStart(); } },
    endTurn() {},
    tune() {},
    flush() { this.flushed += 1; this.playing = false; },
    close() {},
    boop() {},
    heardShare: () => 1,
    micLevel: () => 0,
    onIdle: () => {},
    onStart: () => {},
  };
}

const loudFrame = () => new Int16Array(160).fill(4_000).buffer;
const bot = (id: string, text: string, extra: Partial<Message> = {}) => ({ id, role: "bot", kind: "text", text, at: 2_000, ...extra }) as Message;
const user = (id: string, text: string) => ({ id, role: "user", kind: "text", text, at: 2_000 }) as Message;

function setup(token: Posted = { status: 200, data: { callId: "c-0123456789ab", url: "wss://x", token: "t", model: "m" } }) {
  const engines: FakeEngine[] = [];
  const posts: Array<{ path: string; body: any }> = [];
  const sent: string[] = [];
  const audio = fakeAudio();
  let clock = 1_000;
  const call = new SameBotCall({
    botId: "b1",
    engine: () => { const engine = new FakeEngine(); engines.push(engine); return engine; },
    audio,
    now: () => clock,
    post: async (path, body) => { posts.push({ path, body }); return path.endsWith("/call/token") ? token : { status: 200, data: {} }; },
    send: (text) => sent.push(text),
  });
  return { call, audio, posts, sent, engine: () => engines.at(-1)!, tick: (ms: number) => { clock += ms; } };
}

async function started() {
  const s = setup();
  await s.call.start();
  s.engine().events.ready();
  s.call.observe({ busy: false, messages: [user("u0", "earlier"), bot("b0", "An old reply that must stay unread.")] });
  return s;
}

/** He says a line; Gemini's own turn for it ends. */
function say(s: Awaited<ReturnType<typeof started>>, text: string) {
  s.audio.mic!(loudFrame());
  s.engine().events.heard(text);
  s.engine().events.answering();
  s.engine().events.audio(new ArrayBuffer(8));
  s.engine().events.turnDone();
}

afterEach(() => { vi.restoreAllMocks(); });

describe("same-bot call", () => {
  it("asks for a voice with no brief: the token says mode bot", async () => {
    const s = await started();
    const token = s.posts.find((post) => post.path === "/api/bots/b1/call/token")!;
    expect(token.body).toMatchObject({ mode: "bot" });
    expect(s.call.state().status).toBe("listening");
  });

  it("sends what he says to the bot as a chat message and never plays the voice's own answer", async () => {
    const s = await started();
    say(s, "what is the build status");
    expect(s.sent).toEqual(["what is the build status"]);
    expect(s.audio.played).toBe(0);
    expect(s.engine().texts).toEqual([]);
    expect(s.call.state().status).toBe("working");
  });

  it("drops a mutter but sends a yes", async () => {
    const s = await started();
    say(s, "hmm");
    say(s, "yes");
    expect(s.sent).toEqual(["yes"]);
  });

  it("reads the bot's own reply once its turn settles, a sentence per voice turn", async () => {
    const s = await started();
    say(s, "how is the login fix going");
    const asked = [user("u0", "earlier"), bot("b0", "An old reply that must stay unread."), user("u1", "how is the login fix going")];
    s.call.observe({ busy: true, messages: asked });
    s.call.observe({ busy: true, messages: [...asked, bot("b1", "Halfway there.")] });
    expect(s.engine().texts).toEqual([]);
    const reply = "The login fix is merged and the tests pass now. I am deploying it to staging next, which takes about five minutes.";
    s.call.observe({ busy: false, messages: [...asked, bot("b2", reply)] });
    const [first] = s.engine().texts;
    expect(first).toMatch(/^\[READ\]\nThe login fix is merged/);
    expect(s.engine().texts).toHaveLength(1);
    expect(s.call.state().status).toBe("speaking");

    s.engine().events.answering();
    s.engine().events.audio(new ArrayBuffer(8));
    s.engine().events.said("The login fix is merged");
    expect(s.audio.played).toBe(1);
    expect(s.call.state().caption).toMatchObject({ who: "voice", text: "The login fix is merged" });
    s.engine().events.turnDone();
    expect(s.engine().texts).toHaveLength(2);
    expect(s.engine().texts.join(" ")).toContain("staging next");
    expect(s.engine().texts.join(" ")).not.toContain("old reply");
    expect(s.engine().texts.join(" ")).not.toContain("Halfway");
  });

  it("never reads a line the voice itself wrote into the chat", async () => {
    const s = await started();
    s.call.observe({ busy: false, messages: [bot("v1", "Calling about the deploy.", { call: { id: "c-0123456789ab" } } as Partial<Message>)] });
    expect(s.engine().texts).toEqual([]);
  });

  it("keeps the mic shut while it reads, so the voice never hears itself", async () => {
    const s = await started();
    s.audio.mic!(loudFrame());
    expect(s.engine().frames).toBe(1);
    s.call.observe({ busy: false, messages: [bot("b9", "Here is a reply long enough to read.")] });
    s.audio.mic!(loudFrame());
    expect(s.engine().frames).toBe(1);
    expect(s.engine().paused).toBe(1);
    s.engine().events.heard("echo of the reply");
    s.engine().events.answering();
    s.engine().events.turnDone();
    expect(s.sent).toEqual([]);
  });

  it("stops reading at a tap and listens again", async () => {
    const s = await started();
    s.call.observe({ busy: false, messages: [bot("b9", "First part of a long reply here. Second part that he does not want. Third part as well.")] });
    s.engine().events.answering();
    s.engine().events.audio(new ArrayBuffer(8));
    expect(s.call.state().status).toBe("speaking");
    s.call.interrupt();
    expect(s.audio.flushed).toBe(1);
    s.engine().events.audio(new ArrayBuffer(8));
    expect(s.audio.played).toBe(1);
    s.engine().events.turnDone();
    expect(s.engine().texts).toHaveLength(1);
    expect(s.call.state().status).toBe("listening");
    say(s, "actually wait");
    expect(s.sent).toEqual(["actually wait"]);
  });

  it("times the first spoken word from his last loud frame", async () => {
    const s = await started();
    s.audio.mic!(loudFrame());
    s.engine().events.heard("status please");
    s.tick(1_200);
    s.engine().events.answering();
    s.engine().events.turnDone();
    s.tick(800);
    s.call.observe({ busy: false, messages: [bot("b9", "All green, nothing waiting on you.")] });
    s.engine().events.answering();
    s.tick(300);
    s.engine().events.audio(new ArrayBuffer(8));
    expect(s.call.firstWordMs).toEqual([2_300]);
  });

  it("asks for a key on 409 and ends quietly when the voice is out", async () => {
    const key = setup({ status: 409, data: {} });
    await key.call.start();
    expect(key.call.state().status).toBe("needsKey");
    const out = setup({ status: 429, data: {} });
    await out.call.start();
    expect(out.call.state()).toMatchObject({ status: "failed", error: VOICE_OUT });
  });

  it("hangs up cleanly", async () => {
    const s = await started();
    s.call.end();
    expect(s.engine().closed).toBe(true);
    expect(s.call.state().status).toBe("ended");
    expect(s.posts.some((post) => post.path.endsWith("/call/end"))).toBe(true);
  });
});
