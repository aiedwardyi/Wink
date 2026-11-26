import { afterEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@/state/store-types";
import { READY_MS, VOICE_OUT, type CallAudioPort, type Posted } from "./controller";
import type { LiveEngine, LiveEvents } from "./engine";
import { SameBotCall } from "./same-bot";
import { sameBotSetup } from "../../../server/same-bot-call.ts";

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

type FakeAudio = Omit<CallAudioPort, "playing"> & { playing: boolean; played: number; flushed: number; mic?: (pcm: ArrayBuffer) => void };
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
const user = (id: string, text: string, sendId?: string) => ({ id, role: "user", kind: "text", text, at: 2_000, ...(sendId ? { sendId } : {}) }) as Message;

function setup(token: Posted = { status: 200, data: { callId: "c-0123456789ab", url: "wss://x", token: "t", model: "m" } }) {
  const engines: FakeEngine[] = [];
  const posts: Array<{ path: string; body: any }> = [];
  const sent: string[] = [];
  const ids: string[] = [];
  const rejects: Array<(stopped?: boolean) => void> = [];
  const audio = fakeAudio();
  let minted = token;
  let clock = 1_000;
  const call = new SameBotCall({
    botId: "b1",
    engine: () => { const engine = new FakeEngine(); engines.push(engine); return engine; },
    audio,
    now: () => clock,
    post: async (path, body) => { posts.push({ path, body }); return path.endsWith("/call/token") ? minted : { status: 200, data: {} }; },
    send: (text, sendId, onError) => { sent.push(text); ids.push(sendId); rejects.push(onError); },
  });
  return { call, audio, posts, sent, ids, rejects, engines, mint: (next: Posted) => { minted = next; }, engine: () => engines.at(-1)!, tick: (ms: number) => { clock += ms; } };
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
  s.engine().events.audio(new Int16Array(4));
  s.engine().events.turnDone();
}

/** He asks; the bot's turn for it settles with this reply. */
function answered(s: Awaited<ReturnType<typeof started>>, reply: string) {
  say(s, "tell me");
  s.call.observe({ busy: false, messages: [user("u1", "tell me", s.ids.at(-1)), bot("b9", reply)] });
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

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
    const asked = [user("u0", "earlier"), bot("b0", "An old reply that must stay unread."), user("u1", "how is the login fix going", s.ids[0])];
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
    s.engine().events.audio(new Int16Array(4));
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

  it("his words close to the read's still stop it and are sent", async () => {
    for (const [reply, his] of [["The build passed on step three.", "No, the build failed on step two."], ["배포가 3단계에서 실패했습니다.", "잠깐만, 그거 말고 테스트 결과 알려줘"]]) {
      const s = await started();
      answered(s, reply);
      s.engine().events.answering();
      s.engine().events.audio(new Int16Array(4));
      s.engine().events.said(reply);
      s.engine().events.turnDone();
      s.audio.mic!(loudFrame());
      s.engine().events.heard(his);
      expect(s.audio.flushed).toBe(1);
      s.engine().events.answering();
      s.engine().events.turnDone();
      expect(s.sent).toEqual(["tell me", his]);
    }
  });

  it("stops reading when he talks over it, and sends what he said", async () => {
    const s = await started();
    answered(s, "A reply long enough to be read aloud for a while.");
    s.engine().events.answering();
    s.engine().events.audio(new Int16Array(4));
    s.engine().events.said("A reply long enough to be read aloud for a while.");
    s.engine().events.turnDone();
    expect(s.call.state().status).toBe("speaking");
    const frames = s.engine().frames;
    s.audio.mic!(loudFrame());
    expect(s.engine().frames).toBe(frames + 1);
    s.engine().events.heard("wait, stop that");
    expect(s.audio.flushed).toBe(1);
    expect(s.call.state().status).toBe("listening");
    s.engine().events.heard(" and check the logs");
    s.engine().events.answering();
    s.engine().events.turnDone();
    expect(s.sent).toEqual(["tell me", "wait, stop that and check the logs"]);
  });

  it("its own voice coming back through the mic neither stops the read nor is sent", async () => {
    const s = await started();
    answered(s, "A reply long enough to be read aloud for a while.");
    s.engine().events.answering();
    s.engine().events.audio(new Int16Array(4));
    s.engine().events.said("A reply long enough to be read aloud for a while.");
    s.engine().events.turnDone();
    s.audio.mic!(loudFrame());
    s.engine().events.heard("a reply long enough");
    s.engine().events.heard(" to be read");
    s.engine().events.heard("yeah");
    expect(s.audio.flushed).toBe(0);
    expect(s.call.state().status).toBe("speaking");
    s.engine().events.answering();
    s.engine().events.turnDone();
    s.audio.flush();
    s.audio.onIdle();
    expect(s.sent).toEqual(["tell me"]);
  });

  it("Google never cuts a read itself: its own voice, a nod or a noise heard mid-read is not sent and the rest is still read", async () => {
    const googleCuts = sameBotSetup("Atlas").realtimeInputConfig.activityHandling !== "NO_INTERRUPTION";
    for (const heard of ["first i checked the build", "Yeah.", ""]) {
      const s = await started();
      answered(s, "First I checked the build. Then I ran the tests.");
      s.engine().events.answering();
      s.engine().events.audio(new Int16Array(4));
      s.engine().events.said("First I checked the build.");
      s.audio.mic!(loudFrame());
      if (googleCuts) {
        s.engine().events.interrupted();
        s.engine().events.turnDone();
      }
      if (heard) s.engine().events.heard(heard);
      if (!googleCuts) s.engine().events.turnDone();
      s.engine().events.answering();
      s.engine().events.turnDone();
      expect(s.sent).toEqual(["tell me"]);
      expect(s.engine().texts).toEqual(["[READ]\nFirst I checked the build.", "[READ]\nThen I ran the tests."]);
    }
  });

  it("its own voice heard back a little wrong is still its own: a misheard word, a number in words, a contraction spelled out", async () => {
    for (const [reply, echo] of [
      ["A reply long enough to be read aloud for a while.", "a reply along enough to be red aloud"],
      ["PR 2148 merged at 5 PM.", "pr twenty one forty eight merged at five pm"],
      ["It's done and I'm deploying it now.", "it is done and i am deploying it now"],
      ["A reply long enough to be read aloud for a while.", "a reply long enough to read aloud for a while"],
      ["First I checked the build and then the tests.", "first i checked the bill and then the tests"],
      ["A reply long enough to be read aloud for a while.", "a reply long enough to be read out aloud for a while"],
      ["That plan costs $20 a month and the build is 50% done.", "that plan costs twenty dollars a month and the build is fifty percent done"],
      ["배포가 3단계에서 실패했습니다. 로그를 확인해 주세요.", "배포가 3 단계에서 실패했습니다"],
      ["배포가 3단계에서 실패했습니다. 로그를 확인해 주세요.", "배포가 3단계에서 실패했읍니다"],
      ["배포가 3단계에서 실패했습니다. 로그를 확인해 주세요.", "배포가 삼단계에서 실패했습니다"],
    ] as const) {
      const s = await started();
      answered(s, reply);
      s.engine().events.answering();
      s.engine().events.audio(new Int16Array(4));
      s.engine().events.said(reply);
      s.engine().events.turnDone();
      s.audio.mic!(loudFrame());
      s.engine().events.heard(echo);
      expect(s.audio.flushed).toBe(0);
      expect(s.call.state().status).toBe("speaking");
      s.engine().events.answering();
      s.engine().events.turnDone();
      expect(s.sent).toEqual(["tell me"]);
    }
  });

it("its own voice transcribed after the read ended is still its own, and what he says once Google's turn for it ends is his", async () => {
    for (const [during, late] of [["a reply long enough to be", " read aloud for a while"], ["", "a reply long enough to be read aloud for a while"], ["a reply long enough to be read aloud for a", " while."]]) {
      const s = await started();
      answered(s, "A reply long enough to be read aloud for a while.");
      s.engine().events.answering();
      s.engine().events.audio(new Int16Array(4));
      s.engine().events.said("A reply long enough to be read aloud for a while.");
      s.engine().events.turnDone();
      s.audio.mic!(loudFrame());
      if (during) s.engine().events.heard(during);
      s.audio.flush();
      s.audio.onIdle();
      expect(s.call.state().status).toBe("listening");
      s.engine().events.heard(late);
      s.engine().events.answering();
      s.engine().events.turnDone();
      expect(s.sent).toEqual(["tell me"]);
      expect(s.call.state().status).toBe("listening");
      say(s, "yes");
      expect(s.sent).toEqual(["tell me", "yes"]);
    }
  });

  it("a sound during the read that Google gives no turn does not hold back his answer after it", async () => {
    const question = "Should I go ahead and deploy it, or keep the old build?";
    for (const during of ["", "should i go ahead and deploy it"]) {
      for (const his of ["Yes.", "Okay.", "네.", "Go ahead.", "Deploy it.", "Keep the old build."]) {
        const s = await started();
        answered(s, question);
        s.engine().events.answering();
        s.engine().events.audio(new Int16Array(4));
        s.engine().events.said(question);
        s.engine().events.turnDone();
        s.audio.mic!(loudFrame());
        if (during) s.engine().events.heard(during);
        s.audio.flush();
        s.audio.onIdle();
        say(s, his);
        expect(s.sent).toEqual(["tell me", his]);
      }
    }
    const s = await started();
    answered(s, "First I checked the build. Then I ran the tests. Finally I looked at the deploy log.");
    for (const part of ["First I checked the build.", "Then I ran the tests.", "Finally I looked at the deploy log."]) {
      s.engine().events.answering();
      s.engine().events.audio(new Int16Array(4));
      s.engine().events.said(part);
      if (part.startsWith("First")) s.audio.mic!(loudFrame());
      s.engine().events.turnDone();
    }
    s.audio.flush();
    s.audio.onIdle();
    say(s, "Yes.");
    expect(s.sent).toEqual(["tell me", "Yes."]);
  });

  it("words held as maybe its own voice after the read are his once Google's turn for them ends, unless they go on its own words", async () => {
    const question = "Should I go ahead and deploy it?";
    for (const his of ["Yes, go ahead.", "Go ahead.", "Deploy it."]) {
      const s = await started();
      answered(s, question);
      s.engine().events.answering();
      s.engine().events.audio(new Int16Array(4));
      s.engine().events.said(question);
      s.engine().events.turnDone();
      s.audio.mic!(loudFrame());
      s.audio.flush();
      s.audio.onIdle();
      s.engine().events.heard(his);
      s.engine().events.answering();
      s.engine().events.turnDone();
      expect(s.sent).toEqual(["tell me", his]);
    }
    const s = await started();
    answered(s, question);
    s.engine().events.answering();
    s.engine().events.audio(new Int16Array(4));
    s.engine().events.said(question);
    s.engine().events.turnDone();
    s.audio.mic!(loudFrame());
    s.engine().events.heard("should i go ahead and");
    s.audio.flush();
    s.audio.onIdle();
    s.engine().events.heard(" deploy it");
    s.engine().events.answering();
    s.engine().events.turnDone();
    expect(s.sent).toEqual(["tell me"]);
  });

  it("his own words heard after the read ended still go to the bot once", async () => {
    const s = await started();
    answered(s, "A reply long enough to be read aloud for a while.");
    s.engine().events.answering();
    s.engine().events.audio(new Int16Array(4));
    s.engine().events.said("A reply long enough to be read aloud for a while.");
    s.engine().events.turnDone();
    s.audio.mic!(loudFrame());
    s.audio.flush();
    s.audio.onIdle();
    s.engine().events.heard("wait, what about");
    s.engine().events.heard(" the deploy logs");
    s.engine().events.answering();
    s.engine().events.turnDone();
    expect(s.sent).toEqual(["tell me", "wait, what about the deploy logs"]);
  });

  it("a nod followed by its own voice neither stops the read nor is sent; a nod followed by his words stops it", async () => {
    for (const [nod, echo] of [["Yeah.", " long enough to be read aloud"], ["Mm.", " long enough to be read aloud"], ["Okay.", " a reply long enough to be read aloud for a while"]]) {
      const s = await started();
      answered(s, "A reply long enough to be read aloud for a while.");
      s.engine().events.answering();
      s.engine().events.audio(new Int16Array(4));
      s.engine().events.said("A reply long enough to be read aloud for a while.");
      s.engine().events.turnDone();
      s.audio.mic!(loudFrame());
      s.engine().events.heard(nod);
      s.engine().events.heard(echo);
      expect(s.audio.flushed).toBe(0);
      expect(s.call.state().status).toBe("speaking");
      s.audio.flush();
      s.audio.onIdle();
      s.engine().events.answering();
      s.engine().events.turnDone();
      expect(s.sent).toEqual(["tell me"]);
    }
    const s = await started();
    answered(s, "A reply long enough to be read aloud for a while.");
    s.engine().events.answering();
    s.engine().events.audio(new Int16Array(4));
    s.engine().events.said("A reply long enough to be read aloud for a while.");
    s.engine().events.turnDone();
    s.audio.mic!(loudFrame());
    s.engine().events.heard("Yeah.");
    expect(s.audio.flushed).toBe(0);
    s.engine().events.heard(" Wait, stop.");
    expect(s.audio.flushed).toBe(1);
    s.engine().events.answering();
    s.engine().events.turnDone();
    expect(s.sent).toEqual(["tell me", "Yeah. Wait, stop."]);
  });

  it("stops reading at a tap and listens again", async () => {
    const s = await started();
    answered(s, "First part of a long reply here. Second part that he does not want. Third part as well.");
    s.engine().events.answering();
    s.engine().events.audio(new Int16Array(4));
    expect(s.call.state().status).toBe("speaking");
    s.call.interrupt();
    expect(s.audio.flushed).toBe(1);
    s.engine().events.audio(new Int16Array(4));
    expect(s.audio.played).toBe(1);
    s.engine().events.turnDone();
    expect(s.engine().texts).toHaveLength(1);
    expect(s.call.state().status).toBe("listening");
    say(s, "actually wait");
    expect(s.sent).toEqual(["tell me", "actually wait"]);
  });

  it("times the first spoken word from his last loud frame", async () => {
    const s = await started();
    s.audio.mic!(loudFrame());
    s.engine().events.heard("status please");
    s.tick(1_200);
    s.engine().events.answering();
    s.engine().events.turnDone();
    s.tick(800);
    s.call.observe({ busy: false, messages: [user("u1", "status please", s.ids[0]), bot("b9", "All green, nothing waiting on you.")] });
    s.engine().events.answering();
    s.tick(300);
    s.engine().events.audio(new Int16Array(4));
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

  it("reads only replies to its own sends: switching to a task with a stored reply reads nothing", async () => {
    const s = await started();
    s.call.observe({ busy: false, messages: [user("p1", "an older ask", "old-send"), bot("p2", "Another task's stored reply.")] });
    expect(s.engine().texts).toEqual([]);
    expect(s.call.state().status).toBe("listening");
  });

  it("reads every settled reply once, in order", async () => {
    const s = await started();
    say(s, "first question");
    s.call.observe({ busy: true, messages: [user("u1", "first question", s.ids[0])] });
    say(s, "second question");
    const rows = [user("u1", "first question", s.ids[0]), user("u2", "second question", s.ids[1]), bot("b3", "First answer."), bot("b4", "Second answer.")];
    s.call.observe({ busy: true, messages: rows });
    s.call.observe({ busy: false, messages: rows });
    s.engine().events.answering();
    s.engine().events.turnDone();
    s.call.observe({ busy: false, messages: rows });
    s.engine().events.answering();
    s.engine().events.turnDone();
    expect(s.engine().texts).toEqual(["[READ]\nFirst answer.", "[READ]\nSecond answer."]);
    expect(s.call.state().status).toBe("listening");
  });

  it("reads a line again on the new socket when a reconnect cuts it", async () => {
    const s = await started();
    answered(s, "Reconnect reply.");
    expect(s.engine().texts).toEqual(["[READ]\nReconnect reply."]);
    s.engine().events.resumable("handle");
    s.engine().events.goAway();
    await vi.waitFor(() => expect(s.engines).toHaveLength(2));
    s.engine().events.ready();
    expect(s.engine().texts).toEqual(["[READ]\nReconnect reply."]);
  });

  it("a reply the server cuts in on drops the rest of that reply, as a tap does", async () => {
    const s = await started();
    answered(s, "First part of a long reply here. Second part that he cut in on. Third part as well.");
    s.engine().events.answering();
    s.engine().events.audio(new Int16Array(4));
    s.engine().events.interrupted();
    say(s, "actually wait");
    expect(s.sent).toEqual(["tell me", "actually wait"]);
    expect(s.engine().texts).toHaveLength(1);
  });

  it("keeps hearing him while a reply waits for his sentence to end", async () => {
    const s = await started();
    say(s, "tell me");
    s.audio.mic!(loudFrame());
    s.engine().events.heard("and also ");
    s.call.observe({ busy: false, messages: [user("u1", "tell me", s.ids.at(-1)), bot("b9", "The reply that arrives mid-sentence.")] });
    expect(s.engine().texts).toEqual([]);
    expect(s.call.state().status).toBe("listening");
    s.audio.mic!(loudFrame());
    expect(s.engine().frames).toBe(3);
    s.engine().events.heard("run the tests");
    s.engine().events.answering();
    s.engine().events.turnDone();
    expect(s.sent).toEqual(["tell me", "and also run the tests"]);
    expect(s.engine().texts).toEqual(["[READ]\nThe reply that arrives mid-sentence."]);
  });

  it("a keyless try's late mic does not stop the mic a retry is using", async () => {
    const s = setup({ status: 409, data: {} });
    const grants: Array<() => void> = [];
    s.audio.capture = async function (onFrame) { this.mic = onFrame; await new Promise<void>((grant) => grants.push(grant)); };
    const stopped = vi.spyOn(s.audio, "stopMic");
    await s.call.start();
    expect(s.call.state().status).toBe("needsKey");
    s.mint({ status: 200, data: { callId: "c-0123456789ab", url: "wss://x", token: "t", model: "m" } });
    const retry = s.call.start();
    await vi.waitFor(() => expect(grants).toHaveLength(2));
    grants[1]!();
    await retry;
    grants[0]!();
    for (let tick = 0; tick < 6; tick++) await Promise.resolve();
    expect(stopped).not.toHaveBeenCalled();
  });

  describe("a voice or language pick", () => {
    const aoede: Posted = { status: 200, data: { callId: "c-0123456789ab", url: "wss://x", token: "t", model: "m", voice: "Aoede", locale: "en" } };
    const swaps = (s: ReturnType<typeof setup>) => s.posts.filter(({ path, body }) => path.endsWith("/call/token") && body.swap);

    it("opens a new session with it, as a Gemini call does, and reads on that one", async () => {
      const s = setup(aoede);
      await s.call.start();
      s.engine().events.ready();
      s.mint({ status: 200, data: { ...aoede.data, voice: "Puck" } });
      s.call.retune({ voice: "Puck" });
      await vi.waitFor(() => expect(s.engines).toHaveLength(2));
      expect(swaps(s)).toMatchObject([{ body: { callId: "c-0123456789ab", swap: true, call: { voice: "Puck" } } }]);
      expect(s.engines[0]!.closed).toBe(true);
      s.engine().events.ready();
      answered(s, "Read in the new voice.");
      expect(s.engines[1]!.texts).toEqual(["[READ]\nRead in the new voice."]);
      s.call.retune({ voice: "Puck" });
      expect(swaps(s)).toHaveLength(1);
    });

    it("waits for the words in progress, then swaps", async () => {
      const s = setup(aoede);
      await s.call.start();
      s.engine().events.ready();
      answered(s, "A reply that is being read now.");
      s.call.retune({ language: "ko" });
      await Promise.resolve();
      expect(swaps(s)).toHaveLength(0);
      s.engine().events.answering();
      s.engine().events.turnDone();
      await vi.waitFor(() => expect(s.engines).toHaveLength(2));
      expect(swaps(s)).toMatchObject([{ body: { swap: true, call: { language: "ko" } } }]);
    });

    it("leaves the session alone for speed, volume and a pick it already has", async () => {
      const s = setup(aoede);
      await s.call.start();
      s.engine().events.ready();
      s.call.retune({ speed: 1.2, voice: "Aoede", language: "en" }, 0.5);
      s.call.retune({});
      await Promise.resolve();
      expect(swaps(s)).toHaveLength(0);
      expect(s.engines).toHaveLength(1);
    });

    it("keeps the call on its session when the new one cannot be had", async () => {
      const s = setup(aoede);
      await s.call.start();
      s.engine().events.ready();
      s.mint({ status: 502, data: { error: "no" } });
      s.call.retune({ voice: "Puck" });
      await vi.waitFor(() => expect(swaps(s)).toHaveLength(1));
      await Promise.resolve();
      expect(s.engines).toHaveLength(1);
      expect(s.engines[0]!.closed).toBe(false);
      expect(s.call.state().status).toBe("listening");
    });
  });

  it("leaves Working and says the line was not sent when the send never reached the bot", async () => {
    const s = await started();
    say(s, "check the blocked build");
    expect(s.call.state().status).toBe("working");
    s.rejects[0]!();
    expect(s.call.state()).toMatchObject({ status: "listening", notice: { kind: "notSent", text: "check the blocked build" } });
  });

  it("leaves Working quietly when Stop took the send back before it ran", async () => {
    const s = await started();
    say(s, "check the blocked build");
    expect(s.call.state().status).toBe("working");
    s.rejects[0]!(true);
    expect(s.call.state().status).toBe("listening");
    expect(s.call.state().notice).toBeUndefined();
  });

  it("says the line was not sent even when its failure row settled the turn first", async () => {
    const s = await started();
    say(s, "check the restored task");
    s.call.observe({ busy: false, messages: [user("u1", "check the restored task", s.ids[0]), { id: "f1", parentId: "u1", role: "bot", kind: "activity", tool: { name: "error: context summary version 99", ok: false }, at: 2_001 } as Message] });
    s.rejects[0]!();
    expect(s.call.state()).toMatchObject({ status: "listening", notice: { kind: "notSent", text: "check the restored task" } });
    s.rejects[0]!();
    expect(s.engine().texts).toEqual([]);
  });

  it("drops a socket that never gets ready on the Gemini call's timer", async () => {
    vi.useFakeTimers();
    const s = setup();
    await s.call.start();
    vi.advanceTimersByTime(READY_MS - 1);
    expect(s.call.state().status).toBe("starting");
    vi.advanceTimersByTime(1);
    expect(s.call.state()).toMatchObject({ status: "failed", error: "The call dropped" });
    expect(s.engine().closed).toBe(true);
  });

  it("hangs up cleanly", async () => {
    const s = await started();
    s.call.end();
    expect(s.engine().closed).toBe(true);
    expect(s.call.state().status).toBe("ended");
    expect(s.posts.some((post) => post.path.endsWith("/call/end"))).toBe(true);
  });
});
