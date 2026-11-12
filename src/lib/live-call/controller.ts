// One live call: the voice talks, the bot works. Lines become chat rows, orders wait for a yes, replies come back as [Wink] lines.
import { callStatus, clip, OPTION_CHARS } from "../../../shared/call-status";
import { isVoiceLine, LIVE_VAD, ORDER_EXPIRY_MS, type CallLine } from "../../../shared/live-call";
import { isSentByPerson } from "../../../shared/open-question";
import { activeLocale } from "@/lib/i18n";
import { openQuestion } from "@/lib/open-question";
import type { Message } from "@/state/store-types";
import { bareYes, claimsDone, consentOf } from "./consent";
import type { LiveEngine, LiveEvents, LiveSession, LiveToolCall } from "./engine";
import { asksAboutDone, asksForChange, asksToRepeat, claimOf } from "./guard";

export const MIC_BLOCKED = "Microphone blocked";
export const MIC_MISSING = "Microphone missing";
export const MIC_BUSY = "Microphone busy";
const MIC_ERRORS: Record<string, string> = { NotAllowedError: MIC_BLOCKED, NotFoundError: MIC_MISSING, OverconstrainedError: MIC_MISSING, NotReadableError: MIC_BUSY };

export type CallStatus = "starting" | "needsKey" | "listening" | "speaking" | "working" | "paused" | "ended" | "failed";
export type CallState = {
  status: CallStatus;
  startedAt?: number;
  muted: boolean;
  pending?: { order: string; expiresAt: number };
  error?: string;
  /** The line being spoken, kept after its turn until the next one starts. */
  caption?: { id: number; who: CallLine["who"]; text: string };
  /** The last order or ask that never reached the bot, or got no reply. */
  notice?: { kind: "notSent" | "noReply"; text: string; why?: string };
};

export type CallAudioPort = {
  capture(onFrame: (pcm: ArrayBuffer) => void): Promise<void>;
  heal(): Promise<boolean>;
  play(pcm: Int16Array): void;
  flush(): void;
  close(): void;
  ring(): void;
  stopRing(): void;
  boop(): void;
  heardShare(): number;
  readonly playing: boolean;
  onIdle: () => void;
  onStart: () => void;
};

export type Posted = { status: number; data: Record<string, any> };

type Deps = {
  botId: string;
  botName: string;
  device: "phone" | "desktop";
  engine: () => LiveEngine;
  audio: CallAudioPort;
  post: (path: string, body: object) => Promise<Posted>;
  now?: () => number;
};

type ToolRun = (call: LiveCall, args: Record<string, unknown>, id: string) => void;

// One table; later cards add their tools here.
const TOOLS: Record<string, ToolRun> = {
  propose_work: (call, args, id) => call.propose(String(args.order ?? "").trim(), [id]),
  ask: (call, args, id) => call.query(String(args.question ?? "").trim(), id),
};

/** One thing the person said: a request until something real accounts for it. */
type Request = { text: string; accounted: boolean; nudged: boolean; failed: boolean; told: boolean; asks: Map<string, Promise<string>> };
/** A [Wink] line waiting for the voice to be quiet. */
type Held = { text: string; valid?: () => boolean; played?: () => void; cut?: () => void; nudge?: true };

const HANGUL = /[가-힣]/g;
const LETTER = /\p{L}/gu;
const MAX_RECONNECTS = 3;
const MAX_NUDGES = 3;
// A gate input with no engine event for this long is stale: a stray fragment, not a turn.
const QUIET_MS = 4_000;
const REPORT_CHARS = 1_500;
const RETRY_MS = 1_500;
const STATUS_MS = 30_000;

const orderKey = (order: string) => order.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const reached = (result: string) => result === "sent" || result === "queued";
const CHANGE_ASK = "not sent: this changes something, so offer it with propose_work and wait for a yes";
// The voice told a bare "expired" or "replaced" says they declined.
const UNANSWERED: Record<string, string> = { expired: "expired: no answer came in time. They did not decline.", replaced: "replaced: a newer offer took its place. They did not decline." };
const reasonOf = (result: string) => result.replace(/^not (?:sent|confirmed): /, "");
const request = (text: string): Request => ({ text, accounted: false, nudged: false, failed: false, told: false, asks: new Map() });
const OFFER_EN = /^(?:(?:do you )?want me to|would you like me to|shall i|should i)\s+/i;
// "How can I help?" and "무엇을 도와드릴까요?" ask, they offer nothing to say yes to.
const offered = (said: string) => {
  const last = said.split(/(?<=[.!?])\s+/).at(-1) ?? "";
  return /\?\s*$/.test(last) && (OFFER_EN.test(last) || (/(할까요|드릴까요|줄까요)\s*\?\s*$/.test(last) && !/무엇|뭐|뭘|무슨|어떤|어떻게|어디|언제|누구/.test(last)));
};

/** The voice's offer as the person's request: "Want me to fix it?" posts as "Fix it." */
export function asRequest(order: string): string {
  const text = order.trim();
  if (OFFER_EN.test(text)) {
    const rest = text.replace(OFFER_EN, "").replace(/[?.!\s]+$/, "").replace(/\b(for|to|with|give|send|show|tell) you\b/gi, "$1 me").replace(/\byour\b/gi, "my");
    return `${rest.charAt(0).toUpperCase()}${rest.slice(1)}.`;
  }
  return text.replace(/\s?드릴까요\s*\?*$/, "줘.").replace(/할까요\s*\?*$/, "해줘.");
}

/** "Sent: X", "Not sent: X (why)": how a result reads aloud and in the chat. */
export function told(result: string, subject: string): string {
  if (reached(result) || result === "already sent") return `${result === "queued" ? "Queued" : "Sent"}: ${subject}`;
  if (result.startsWith("already proposed")) return `Waiting for their answer: ${subject}`;
  return `${result.startsWith("not confirmed") ? "Not confirmed" : "Not sent"}: ${subject} (${reasonOf(result)})`;
}

/** How the bot's open card reads aloud: its question and options, never just the title. */
function cardNotice(botName: string, card: Message["card"]): string {
  const question = (card?.subtitle?.trim() || card?.title?.trim() || "").slice(0, REPORT_CHARS);
  const options = card?.options?.filter((option) => option.trim()).map((option) => clip(option, OPTION_CHARS)).join("; ");
  return options
    ? `[Wink] ${botName} asks: ${question} Options: ${options}. Read it out with the options, then wait for their answer.`
    : `[Wink] ${botName} asks: ${question} Read it out, then wait for their answer.`;
}

/** Transcript text without the model's markers ("<no speech>", "{pause}"); empty if nothing speakable is left. */
export function spokenText(text: string): string {
  const clean = text.replace(/<[^>]*>|\{[^}]*\}/g, " ").replace(/\s+/g, " ").trim();
  return /[\p{L}\p{N}]/u.test(clean) ? clean : "";
}

// First audio is timed from the last frame with speech in it: the gap the user hears.
function loud(pcm: ArrayBuffer): boolean {
  for (const sample of new Int16Array(pcm)) if (sample > 1_000 || sample < -1_000) return true;
  return false;
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

export class LiveCall {
  private readonly deps: Deps;
  private readonly now: () => number;
  private engine: LiveEngine | null = null;
  private listeners = new Set<() => void>();
  private snapshot: CallState = { status: "starting", muted: false };
  private callId?: string;
  private threadId?: string;
  private writes = new Set<Promise<unknown>>();
  private sends = new Set<Promise<unknown>>();
  private handle?: string;
  private connected = false;
  private wasLive = false;
  private reconnecting = 0;
  private heardBuf = "";
  private saidBuf = "";
  private lastSaid = "";
  private softCut = false;
  private settleTimer?: ReturnType<typeof setTimeout>;
  private lines = 0;
  private lineIds: Record<CallLine["who"], number> = { user: 0, voice: 0 };
  private guarded = false;
  private doneTold = false;
  private generating = false;
  private quiet = false;
  private quietTimer?: ReturnType<typeof setTimeout>;
  private ran = false;
  private req = request("");
  private pending?: { order: string; toolIds: string[]; req: Request; timer: ReturnType<typeof setTimeout> };
  private toolEngines = new Map<string, LiveEngine>();
  private cancelled = new Set<string>();
  private sent = new Set<string>();
  private card?: { id: string; armed: boolean };
  private toldCards = new Set<string>();
  private askAnswered = new Set<string>();
  private justAnswered = false;
  private awaiting = 0;
  private busy = false;
  private reported = new Set<string>();
  private settled = new Set<string>();
  private toldNeeds = new Set<string>();
  private spokeAt = 0;
  private turnHadAudio = false;
  private held: Held[] = [];
  private playing?: { item: Held; ended: boolean };
  private context: string[] = [];
  private letters = { hangul: 0, all: 0 };
  private stats = {
    turns: 0, userLines: 0, voiceLines: 0, interrupted: 0, doneGuard: 0, reconnects: 0,
    orders: { proposed: 0, confirmed: 0, declined: 0, expired: 0, replaced: 0, cancelled: 0, dropped: 0, failed: 0, retried: 0 },
    asks: { sent: 0, retried: 0, answered: 0 },
    guard: { nudges: 0, failLines: 0, promise: 0, cant: 0, unsure: 0 },
    hidden: { spans: 0, ms: 0 }, closeCodes: [] as number[], ttfa: [] as number[], usage: 0,
  };
  private hiddenAt = 0;
  private stalled = false;
  private heals = 0;
  private askSends = new Set<string>();
  private askMs: number[] = [];
  private ack: number[] = [];
  private turnSent = false;
  private turnTtfa?: number;
  private status?: { told: string; at: number; next?: string; timer?: ReturnType<typeof setTimeout> };

  constructor(deps: Deps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    deps.audio.onStart = () => {
      if (!this.turnHadAudio && this.spokeAt) {
        this.turnTtfa = this.now() - this.spokeAt;
        this.stats.ttfa.push(this.turnTtfa);
      }
      this.spokeAt = 0;
      this.turnHadAudio = true;
      this.refresh();
    };
    deps.audio.onIdle = () => {
      this.playedOut();
      this.release();
      this.refresh();
    };
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  state = (): CallState => this.snapshot;

  private set(patch: Partial<CallState>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const fn of [...this.listeners]) fn();
  }

  private refresh() {
    const { status } = this.snapshot;
    if (status === "ended" || status === "failed" || status === "needsKey" || status === "starting") return;
    const next: CallStatus = this.stalled ? "paused" : this.deps.audio.playing ? "speaking" : this.awaiting || this.busy ? "working" : "listening";
    if (next !== status) this.set({ status: next });
  }

  private get ended() {
    return this.snapshot.status === "ended" || this.snapshot.status === "failed";
  }

  async start() {
    this.set({ status: "starting", error: undefined });
    const session = await this.token(false);
    if (!session) return;
    try {
      await this.deps.audio.capture((pcm) => {
        if (!this.connected || this.snapshot.muted) return;
        if (loud(pcm)) this.spokeAt = this.now();
        this.engine?.sendAudio(pcm);
      });
    } catch (error) {
      return this.fail((error instanceof Error && MIC_ERRORS[error.name]) || String(error));
    }
    if (this.ended) return;
    this.set({ startedAt: this.now() });
    if (!this.snapshot.muted) this.deps.audio.ring();
    this.connect(session);
  }

  private async token(resume: boolean): Promise<LiveSession | null> {
    let posted: Posted;
    try {
      posted = await this.deps.post(`/api/bots/${encodeURIComponent(this.deps.botId)}/call/token`, { locale: activeLocale(), ...(this.callId ? { callId: this.callId, resume } : {}) });
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      return null;
    }
    if (posted.status === 409 && !this.callId) {
      this.set({ status: "needsKey" });
      return null;
    }
    if (posted.status !== 200) {
      this.fail(String(posted.data.error ?? `call failed (${posted.status})`));
      return null;
    }
    this.callId = posted.data.callId;
    return { url: posted.data.url, token: posted.data.token, model: posted.data.model, voice: posted.data.voice, ...(resume && this.handle ? { handle: this.handle } : {}) };
  }

  private connect(session: LiveSession) {
    const engine = this.deps.engine();
    this.engine = engine;
    const mine = () => this.engine === engine && !this.ended;
    const events: LiveEvents = {
      ready: () => {
        if (!mine()) return;
        this.connected = true;
        this.wasLive = true;
        this.deps.audio.stopRing();
        const resumed = Boolean(session.handle);
        this.reconnecting = 0;
        this.refresh();
        if (this.snapshot.status === "starting") this.set({ status: "listening" });
        if (!resumed) engine.sendText("[Wink] The call just started. Greet the user in one short sentence.");
        else this.release();
      },
      audio: (pcm) => {
        if (!mine()) return;
        this.stir();
        this.deps.audio.play(pcm);
      },
      heard: (text) => {
        if (!mine()) return;
        this.stir();
        this.heardBuf += text;
        this.caption("user", this.heardBuf);
        if (this.softCut && this.deps.audio.playing) {
          this.softCut = false;
          this.cutPlaying();
          this.deps.audio.flush();
        }
        if (this.pending) this.settle();
      },
      said: (text) => {
        if (!mine()) return;
        this.stir();
        this.saidBuf += text;
        this.caption("voice", this.saidBuf);
        if (this.awaiting && !this.guarded && !this.doneTold && claimsDone(this.saidBuf)) {
          this.doneTold = true;
          this.stats.doneGuard += 1;
          this.held.unshift({ text: `[Wink] Not done yet: ${this.deps.botName} is still working.` });
          this.release();
        }
      },
      answering: () => {
        if (!mine()) return;
        this.stir();
        this.generating = true;
        this.softCut = false;
        this.flushHeard();
      },
      turnDone: () => {
        if (!mine()) return;
        this.stats.turns += 1;
        this.flushHeard();
        this.guard(spokenText(this.saidBuf));
        this.flushSaid(1);
        this.ackOut();
        this.turnHadAudio = false;
        this.generating = false;
        this.guarded = false;
        this.doneTold = false;
        if (this.playing) this.playing.ended = true;
        this.playedOut();
        this.release();
      },
      interrupted: () => {
        if (!mine()) return;
        this.stats.interrupted += 1;
        // Echo or noise can trip barge-in; with no speech heard the received reply plays out.
        if (!spokenText(this.heardBuf)) {
          this.softCut = this.deps.audio.playing;
          this.flushSaid(1);
          this.ackOut();
          this.turnHadAudio = false;
          this.generating = false;
          this.guarded = false;
          this.doneTold = false;
          // A held line whose turn never finished was not heard in full.
          if (!this.playing?.ended) this.cutPlaying();
          return;
        }
        const share = this.deps.audio.heardShare();
        this.deps.audio.flush();
        this.flushSaid(share);
        this.ackOut();
        this.turnHadAudio = false;
        this.generating = false;
        this.guarded = false;
        this.doneTold = false;
        this.cutPlaying();
      },
      toolCall: (calls) => {
        if (!mine()) return;
        // A tool call can come before any audio, so what was heard is its request.
        this.flushHeard();
        for (const call of calls) this.toolEngines.set(call.id, engine);
        // Two offers in one tool message are one order, answered once per id.
        const offers = calls.filter((call) => call.name === "propose_work");
        if (offers.length > 1) this.propose(offers.map((call) => String(call.args.order ?? "").trim()).filter(Boolean).join(" "), offers.map((call) => call.id));
        for (const call of calls) if (offers.length < 2 || call.name !== "propose_work") this.runTool(call);
      },
      toolCancel: (ids) => {
        if (!mine()) return;
        for (const id of ids) this.cancelled.add(id);
        if (this.pending?.toolIds.some((id) => ids.includes(id))) this.stats.orders.cancelled += 1;
      },
      resumable: (handle) => { this.handle = handle; },
      goAway: () => { if (mine()) void this.reconnect(); },
      usage: (total) => { this.stats.usage += total; },
      closed: (code) => {
        if (this.stats.closeCodes.length < 32) this.stats.closeCodes.push(code);
        if (this.engine !== engine || this.ended) return;
        this.connected = false;
        void this.reconnect();
      },
    };
    engine.connect(session, events);
  }

  private async reconnect() {
    const old = this.engine;
    this.engine = null;
    this.connected = false;
    this.flushHeard(this.quiet);
    this.turnHadAudio = false;
    this.generating = false;
    this.guarded = false;
    // A relayed line the dropped socket never finished is said again on the new one.
    if (this.playing && !this.playing.ended) {
      this.held.unshift(this.playing.item);
      this.playing = undefined;
    } else this.cutPlaying();
    old?.close();
    if (this.ended) return;
    if (!this.handle || this.reconnecting >= MAX_RECONNECTS) return this.fail("The call dropped");
    this.reconnecting += 1;
    this.stats.reconnects += 1;
    const session = await this.token(true);
    if (session && !this.ended) this.connect(session);
  }

  private runTool(call: LiveToolCall) {
    const run = TOOLS[call.name];
    if (run) run(this, call.args, call.id);
    else this.engine?.sendToolResult(call.id, call.name, "unknown tool");
  }

  /** A result reaches the voice on the tool call it answers, or as a [Wink] line once that call is gone. */
  private toolResult(ids: string[], name: string, subject: string, result: string, note?: string) {
    // An ask redirected to propose_work shows until its offer replaces it.
    if (subject && !reached(result) && !result.startsWith("already") && !result.startsWith("not needed")) this.notSent(subject, result === CHANGE_ASK ? "needs a yes" : reasonOf(result));
    const engine = this.engine;
    const live = ids.filter((id) => engine && this.toolEngines.get(id) === engine && !this.cancelled.has(id));
    const heard = UNANSWERED[result] ?? result;
    for (const id of live) engine!.sendToolResult(id, name, note ? `${heard}. ${note}` : heard);
    if (live.length) return;
    this.held.push({ text: `[Wink] ${told(heard, subject)}` });
    this.release();
  }

  private notSent(subject: string, why?: string) {
    this.set({ notice: { kind: "notSent", text: subject, ...(why ? { why } : {}) } });
  }

  private get notNeeded() {
    return `not needed: this is ${this.deps.botName}'s open question, and the person's spoken reply goes to ${this.deps.botName} as the answer`;
  }

  propose(order: string, ids: string[]) {
    if (!order) return this.toolResult(ids, "propose_work", order, "not sent: no order given");
    order = asRequest(order);
    // The bot's own question already takes the spoken answer; an order would ask twice.
    if (this.card?.armed || this.justAnswered) return this.toolResult(ids, "propose_work", order, this.notNeeded);
    const key = orderKey(order);
    if (this.sent.has(key)) return this.toolResult(ids, "propose_work", order, "already sent");
    if (this.pending && orderKey(this.pending.order) === key) return this.toolResult(ids, "propose_work", order, "already proposed, waiting for their answer");
    const replaced = Boolean(this.pending);
    if (replaced) {
      this.stats.orders.replaced += 1;
      this.answerTool("replaced");
    }
    this.stats.orders.proposed += 1;
    // A yes to the voice's own question, before it said anything new, already confirms the order.
    const yes = !this.req.accounted && bareYes(this.req.text) && offered(this.lastSaid) && !spokenText(this.saidBuf) && !this.turnHadAudio;
    this.req.accounted = true;
    const expiresAt = this.now() + ORDER_EXPIRY_MS;
    const expire = () => {
      if (this.pending !== pending) return;
      // A yes still being said lands just after the timer; one left stale in the buffer is read now.
      if (spokenText(this.heardBuf)) {
        if (!this.quiet) {
          pending.timer = setTimeout(expire, QUIET_MS);
          return;
        }
        this.flushHeard();
        if (this.pending !== pending) return;
      }
      this.stats.orders.expired += 1;
      pending.req.accounted = false;
      this.answerTool("expired");
    };
    const pending = { order, toolIds: ids, req: this.req, timer: setTimeout(expire, ORDER_EXPIRY_MS) };
    this.pending = pending;
    this.set({ pending: { order, expiresAt }, ...(replaced ? {} : { notice: undefined }) });
    if (yes) void this.answer(true);
  }

  // The model waits on the open propose_work call, so a spoken answer to its card may never get a turn.
  private settle() {
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      if (this.pending && !this.ended && consentOf(spokenText(this.heardBuf))) this.flushHeard();
    }, LIVE_VAD.silenceDurationMs);
  }

  private clearPending() {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = undefined;
    this.set({ pending: undefined });
  }

  private answerTool(result: string) {
    const pending = this.pending;
    if (!pending) return;
    this.clearPending();
    this.toolResult(pending.toolIds, "propose_work", pending.order, result);
  }

  /** Yes or No on the pending order, tapped or spoken. */
  async answer(yes: boolean) {
    const pending = this.pending;
    if (!pending) return;
    if (!yes) {
      this.stats.orders.declined += 1;
      pending.req.accounted = false;
      return this.answerTool("declined");
    }
    this.clearPending();
    this.stats.orders.confirmed += 1;
    const key = orderKey(pending.order);
    this.sent.add(key);
    const req = this.req;
    const said = this.stats.voiceLines;
    const result = await this.send(pending.order, { order: true });
    if (!reached(result)) {
      this.sent.delete(key);
      this.stats.orders.failed += 1;
      pending.req.accounted = req.accounted = false;
      this.postLines([{ who: "voice", text: told(result, pending.order), at: this.now() }]);
    }
    this.toolResult(pending.toolIds, "propose_work", pending.order, result, reached(result) && this.stats.voiceLines > said ? "They already heard you answer: say nothing more." : undefined);
  }

  /** A question for the bot: no yes needed, one send per request however often the voice replays it. */
  query(question: string, id: string) {
    if (!question) return this.toolResult([id], "ask", question, "not sent: no question");
    if (this.card?.armed || this.justAnswered) return this.toolResult([id], "ask", question, this.notNeeded);
    if (asksForChange(question)) return this.toolResult([id], "ask", question, CHANGE_ASK);
    const req = this.req;
    req.accounted = true;
    const key = orderKey(question);
    let run = req.asks.get(key);
    if (!run) {
      this.stats.asks.sent += 1;
      const sendId = crypto.randomUUID();
      this.askSends.add(sendId);
      run = this.send(question, { ask: true }, sendId).then((result) => {
        if (!reached(result)) {
          req.accounted = false;
          this.postLines([{ who: "voice", text: told(result, question), at: this.now() }]);
        }
        return result;
      });
      req.asks.set(key, run);
    }
    void run.then((result) => this.toolResult([id], "ask", question, result));
  }

  private send(text: string, tag: { order: true } | { ask: true }, sendId = crypto.randomUUID()): Promise<string> {
    this.turnSent = true;
    const run = this.deliver(text, tag, sendId);
    this.sends.add(run);
    void run.finally(() => this.sends.delete(run));
    return run;
  }

  // A negative 202 or a 4xx never reached the bot; only a lost receipt is retried, with the same body.
  private async deliver(text: string, tag: { order: true } | { ask: true }, sendId: string): Promise<string> {
    const threadId = this.threadId;
    // The bot reads the call lines before the prompt, so the heard line must land first.
    await Promise.all([...this.writes]);
    const body = { text, sendId, ...(threadId ? { threadId } : {}), call: { id: this.callId, ...tag } };
    let reason = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt) {
        this.stats["order" in tag ? "orders" : "asks"].retried += 1;
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      }
      let sent: Posted;
      try {
        sent = await this.deps.post(`/api/bots/${encodeURIComponent(this.deps.botId)}/messages`, body);
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
        continue;
      }
      const error = String(sent.data.error ?? sent.status);
      if (sent.status >= 500) {
        reason = error;
        continue;
      }
      if (sent.status >= 400) return `not sent: ${error}`;
      if (sent.data.cancelled) return "not sent: cancelled";
      if (sent.data.dispatchFailed) return `not sent: ${sent.data.error ?? "dispatch failed"}`;
      this.awaiting += 1;
      // The row and busy can land before this receipt, leaving no busy render with it awaited.
      if (this.busy) this.ran = true;
      this.set({ notice: undefined });
      this.refresh();
      return sent.data.queued ? "queued" : "sent";
    }
    return `not confirmed: ${reason}`;
  }

  /** A promise of work with nothing behind it gets one nudge per request, then a line saying it was not sent. */
  private guard(said: string) {
    if (this.guarded || !said) return;
    const req = this.req;
    const claim = claimOf(said, asksAboutDone(req.text), !this.pending && !req.accounted && asksForChange(req.text));
    // A turn answering a nudge that still sent nothing is a dropped request, whatever it says.
    if (!claim && !req.nudged) return;
    if (claim?.claim === "failed") {
      req.failed = true;
      if (req.text && !req.accounted && !req.told) this.notSent(req.text);
      return;
    }
    if (this.pending && claim?.claim === "promise") {
      this.held.push({ text: `[Wink] Not sent yet: they have not said yes to "${this.pending.order}". Ask them again.` });
      return;
    }
    if (!req.text || req.accounted || req.failed || req.told) return;
    if (claim) this.stats.guard[claim.claim] += 1;
    if (claim && !req.nudged && this.stats.guard.nudges < MAX_NUDGES) {
      req.nudged = true;
      this.stats.guard.nudges += 1;
      this.held.push({ text: `[Wink] Not done: you said "${claim.sentence}", but nothing was sent, so nothing is running. Call ask or propose_work now${this.busy ? `: ${this.deps.botName} is busy, so it queues after the current work.` : ", or say plainly it was not sent."}`, nudge: true });
      return;
    }
    req.told = true;
    this.stats.guard.failLines += 1;
    this.postLines([{ who: "voice", text: `Not sent: ${req.text}`, at: this.now() }]);
    this.notSent(req.text);
    this.held.push({ text: `[Wink] Not sent: "${req.text}" never reached ${this.deps.botName}, so nothing is running. Tell them plainly it was not sent.` });
  }

  private caption(who: CallLine["who"], buf: string) {
    const text = spokenText(buf);
    if (!text) return;
    this.lineIds[who] ||= ++this.lines;
    this.set({ caption: { id: this.lineIds[who], who, text } });
  }

  // Speech cut off mid-line (a reconnect) is kept as a line but never answers a card or an offer.
  private flushHeard(ended = true) {
    const text = spokenText(this.heardBuf);
    this.heardBuf = "";
    this.lineIds.user = 0;
    if (!text) return;
    if (this.snapshot.notice) this.set({ notice: undefined });
    this.stats.userLines += 1;
    this.letters.hangul += text.match(HANGUL)?.length ?? 0;
    this.letters.all += text.match(LETTER)?.length ?? 0;
    this.justAnswered = false;
    const req = this.req = request(text);
    // The first line after the card was read out is its answer, so it goes to the bot as one.
    const card = this.card;
    if (ended && !this.pending && card?.armed && !asksToRepeat(text)) {
      card.armed = false;
      req.accounted = true;
      this.justAnswered = true;
      const at = this.now();
      void this.send(text, { ask: true }).then((result) => {
        if (reached(result)) {
          this.askAnswered.add(card.id);
          if (this.card === card) this.card = undefined;
          return;
        }
        this.justAnswered = false;
        req.accounted = false;
        this.postLines([{ who: "user", text, at }]);
        this.notSent(text, reasonOf(result));
        if (this.card === card) card.armed = true;
        this.held.push({ text: `[Wink] Not sent: their answer "${text}" did not reach ${this.deps.botName} (${reasonOf(result)}). Say so plainly and ask them to answer again.` });
        this.release();
      });
      return;
    }
    this.postLines([{ who: "user", text, at: this.now() }]);
    if (!this.pending || !ended) return;
    const consent = consentOf(text);
    if (consent === "yes") req.accounted = true;
    if (consent) void this.answer(consent === "yes");
  }

  private flushSaid(share: number) {
    const full = spokenText(this.saidBuf);
    this.saidBuf = "";
    this.lineIds.voice = 0;
    if (!full) return;
    const text = share < 1 ? `${full.slice(0, Math.max(1, Math.round(full.length * share))).trimEnd()}…` : full;
    this.lastSaid = full;
    this.stats.voiceLines += 1;
    this.postLines([{ who: "voice", text, at: this.now() }]);
  }

  /** Every call row goes through here. */
  private postLines(lines: CallLine[]) {
    if (!this.callId) return;
    const write = this.deps.post(`/api/bots/${encodeURIComponent(this.deps.botId)}/call/lines`, { callId: this.callId, lines }).catch(() => {});
    this.writes.add(write);
    void write.finally(() => this.writes.delete(write));
  }

  /** The chat as the store has it: speaks the reply to a voice order, ask or typed message, relays anything waiting on the user. */
  observe(input: { busy: boolean; messages: Message[]; threadId?: string; needs?: { id: string; short: string } }) {
    this.busy = input.busy;
    this.threadId = input.threadId;
    if (input.busy && this.awaiting) this.ran = true;
    if (!this.connected || this.snapshot.startedAt === undefined || this.ended) return this.refresh();
    const startedAt = this.snapshot.startedAt;
    // A quick answer to this call's ask is spoken while the bot keeps working.
    const asks = new Set<string>();
    for (const row of input.messages) {
      if (row.role === "user" && row.call?.ask && row.call.id === this.callId) asks.add(row.id);
      const askId = row.quick?.state === "answer" ? row.quick.askId : undefined;
      if (row.role === "bot" && askId && asks.has(askId) && row.text?.trim() && !this.reported.has(row.id)) {
        this.reported.add(row.id);
        this.answered(input.messages, [askId], row);
        void this.report(row.text, [askId]);
      }
    }
    if (!input.busy) {
      const replies = new Map<Message | undefined, { reply: Message; orders: Message[] }>();
      let asked: Message | undefined;
      let orders: Message[] = [];
      for (const row of input.messages) {
        if (isSentByPerson(row) && !isVoiceLine(row) && row.quick?.state !== "asked" && !row.queued && row.text?.trim()) {
          if (!row.steered || !orders.length) {
            asked = row;
            orders = [];
          }
          if ((row.call?.order || row.call?.ask) && row.call.id === this.callId) orders.push(row);
        } else if (row.role === "bot" && row.kind === "text" && !isVoiceLine(row) && !row.quick && row.at >= startedAt && row.text?.trim() && !this.reported.has(row.id)) {
          this.reported.add(row.id);
          this.justAnswered = false;
          replies.set(asked, { reply: row, orders: [...orders] });
        }
      }
      for (const [order, { reply, orders: replyOrders }] of replies) {
        if (!replyOrders.length) {
          if (order) void this.report(reply.text!, []);
          else this.remember(reply.text!);
          continue;
        }
        // A settled order can be asked for again later in the call.
        for (const row of replyOrders) this.sent.delete(orderKey(row.text!));
        this.answered(replyOrders, replyOrders.map((row) => row.id), reply);
        void this.report(reply.text!, replyOrders.map((row) => row.id));
      }
      if (this.ran) this.stopped(input.messages, openQuestion(input.messages)?.at, Boolean(input.needs && !this.toldNeeds.has(input.needs.id)));
    }
    const question = openQuestion(input.messages);
    const id = question && !this.askAnswered.has(question.id) ? question.id : undefined;
    if (id !== this.card?.id) {
      this.card = id ? { id, armed: false } : undefined;
      if (id && question && !this.toldCards.has(id)) {
        this.toldCards.add(id);
        const notice: Held = {
          text: cardNotice(this.deps.botName, question.card),
          valid: () => this.card?.id === id,
          played: () => { if (this.card?.id === id) this.card.armed = true; },
          // re-queues itself: a cut notice was never heard, so it must play again
          cut: () => { if (this.card?.id === id) this.held.push(notice); },
        };
        this.held.push(notice);
      }
    }
    if (input.needs && !this.toldNeeds.has(input.needs.id)) {
      this.toldNeeds.add(input.needs.id);
      this.held.push({ text: `[Wink] ${this.deps.botName} needs you in chat: ${input.needs.short}` });
    }
    this.statusNow(callStatus(this.deps.botName, input.busy, input.messages));
    this.release();
    this.refresh();
  }

  /** The bot went idle after running: this call's orders it never answered get no reply, so they are told and can be asked again. A question or need raised since is its reply; one still queued has not run. */
  private stopped(messages: Message[], askedAt: number | undefined, newNeed: boolean) {
    this.ran = false;
    const lost: string[] = [];
    for (const row of messages) {
      if (row.role !== "user" || row.call?.id !== this.callId || !(row.call?.order || row.call?.ask) || row.quick?.state === "asked" || row.queued || this.settled.has(row.id) || !row.text?.trim()) continue;
      this.settled.add(row.id);
      this.awaiting = Math.max(0, this.awaiting - 1);
      if (newNeed || (askedAt !== undefined && askedAt >= row.at)) continue;
      this.sent.delete(orderKey(row.text));
      lost.push(row.text);
      this.held.push({ text: `[Wink] ${this.deps.botName} stopped with no reply to "${row.text}". Tell them plainly; they can ask again.` });
    }
    if (lost.length) this.set({ notice: { kind: "noReply", text: lost.join("; ") } });
  }

  /** The first audio of a turn that sent something is how fast the voice acknowledged it. */
  private ackOut() {
    if (this.turnSent && this.turnTtfa !== undefined) this.ack.push(this.turnTtfa);
    this.turnSent = false;
    this.turnTtfa = undefined;
  }

  /** A spoken ask settles once, timed from its row to the answer. */
  private answered(rows: Message[], ids: string[], reply: Message) {
    for (const row of rows) {
      if (!ids.includes(row.id) || !row.sendId || !this.askSends.delete(row.sendId)) continue;
      this.stats.asks.answered += 1;
      this.askMs.push(Math.max(0, reply.at - row.at));
    }
  }

  // The brief already holds the first look; later changes go silently, one per 30 s, the newest kept for a trailing flush.
  private statusNow(text: string) {
    if (!this.status) {
      this.status = { told: text, at: 0 };
      return;
    }
    const status = this.status;
    status.next = text;
    if (status.timer) return;
    const wait = status.at + STATUS_MS - this.now();
    if (status.at && wait > 0) {
      status.timer = setTimeout(() => {
        status.timer = undefined;
        if (!this.ended) this.tellStatus();
      }, wait);
      return;
    }
    this.tellStatus();
  }

  private tellStatus() {
    const status = this.status!;
    const text = status.next;
    status.next = undefined;
    if (!text || text === status.told) return;
    status.told = text;
    status.at = this.now();
    this.context.push(`[Wink] Status now. Context only, do not read it out.\n${text}`);
    this.release();
  }

  private async report(text: string, orders: string[]) {
    for (const id of orders) {
      if (this.settled.has(id)) continue;
      this.settled.add(id);
      this.awaiting = Math.max(0, this.awaiting - 1);
    }
    // Later replies still speak after their orders have settled.
    let speakable = text.slice(0, REPORT_CHARS);
    try {
      const prepared = await this.deps.post("/api/tts/prepare", { text: speakable });
      const utterances = prepared.data.utterances;
      if (Array.isArray(utterances) && utterances.length) speakable = utterances.join(" ");
    } catch {
      // the raw text still reads
    }
    if (this.ended) return;
    this.held.push({ text: `[Wink] ${this.deps.botName} replied: ${speakable}` });
    this.release();
  }

  private remember(reply: string) {
    const head = "[Wink] In chat, already on screen. Context only, do not read it out.\n";
    this.context.push(`${head}${this.deps.botName}: ${reply.trim()}`.slice(0, REPORT_CHARS));
    this.release();
  }

  // Text sent while the voice talks, thinks, listens or has a line in flight cuts it off, so every [Wink] line waits here for quiet.
  private release() {
    if (!this.connected || this.stalled || this.playing || this.turnHadAudio || this.deps.audio.playing || (!this.quiet && (this.generating || spokenText(this.heardBuf)))) return;
    for (const text of this.context.splice(0)) this.engine?.sendContext(text);
    let item = this.held.shift();
    while (item?.valid && !item.valid()) item = this.held.shift();
    if (!item) return;
    // The next turn relays a real result, so the guards sit it out.
    this.guarded = !item.nudge;
    this.playing = { item, ended: false };
    this.engine?.sendText(item.text);
  }

  private stir() {
    this.quiet = false;
    clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => {
      this.quiet = true;
      this.release();
    }, QUIET_MS);
  }

  /** A held line counts as heard once its turn ended and the audio drained. */
  private playedOut() {
    if (!this.playing?.ended || this.deps.audio.playing) return;
    const { item } = this.playing;
    this.playing = undefined;
    item.played?.();
  }

  private cutPlaying() {
    const item = this.playing?.item;
    this.playing = undefined;
    item?.cut?.();
  }

  mute(muted: boolean) {
    this.set({ muted });
    if (muted) {
      this.deps.audio.stopRing();
      this.engine?.audioPaused();
    }
  }

  hidden(isHidden: boolean) {
    if (isHidden) {
      this.hiddenAt = this.now();
      this.stats.hidden.spans += 1;
    } else if (this.hiddenAt) {
      this.stats.hidden.ms += this.now() - this.hiddenAt;
      this.hiddenAt = 0;
      void this.heal();
    }
  }

  /** The tap a phone can need before audio plays again. */
  resume() {
    void this.heal();
  }

  // Android can stop the page's audio and mic while it is away, and nothing else notices on return.
  private async heal() {
    if (this.ended || this.snapshot.startedAt === undefined) return;
    const run = ++this.heals;
    const ok = await this.deps.audio.heal();
    if (this.ended || run !== this.heals) return;
    this.stalled = !ok;
    this.release();
    this.refresh();
  }

  private fail(error: string) {
    this.teardown();
    this.set({ status: "failed", error });
  }

  end() {
    if (this.snapshot.status === "ended") return;
    if (this.snapshot.status !== "failed") {
      if (this.wasLive && !this.snapshot.muted) this.deps.audio.boop();
      this.teardown();
    }
    this.set({ status: "ended" });
  }

  private teardown() {
    const engine = this.engine;
    this.engine = null;
    this.connected = false;
    // A yes said as the call hangs up still sends.
    if (engine) {
      this.flushHeard();
      this.flushSaid(this.deps.audio.heardShare());
    }
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.stats.orders.dropped += 1;
      this.postLines([{ who: "voice", text: `Not sent (call ended): ${this.pending.order}`, at: this.now() }]);
      this.pending = undefined;
    }
    clearTimeout(this.status?.timer);
    clearTimeout(this.quietTimer);
    clearTimeout(this.settleTimer);
    engine?.close();
    this.deps.audio.close();
    if (!this.callId || this.snapshot.startedAt === undefined) return;
    const { ttfa, usage, ...counts } = this.stats;
    const body = {
      callId: this.callId,
      stats: {
        ...counts,
        device: this.deps.device,
        ms: this.now() - this.snapshot.startedAt,
        hangulShare: this.letters.all ? Math.round((this.letters.hangul / this.letters.all) * 100) / 100 : 0,
        ttfaMs: { p50: percentile(ttfa, 0.5), p90: percentile(ttfa, 0.9) },
        ackMs: { p50: percentile(this.ack, 0.5), p90: percentile(this.ack, 0.9) },
        asks: { ...counts.asks, ms: { p50: percentile(this.askMs, 0.5), p90: percentile(this.askMs, 0.9) } },
        usage: { total: usage },
      },
    };
    // The server recaps the call on end, so the last lines and sends must land first.
    void Promise.all([...this.writes, ...this.sends]).then(() => this.deps.post(`/api/bots/${encodeURIComponent(this.deps.botId)}/call/end`, body)).catch(() => {});
  }
}
