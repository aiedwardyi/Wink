// One live call: the voice talks, the bot works. Lines become chat rows, orders wait for a yes, replies come back as [Wink] lines.
import { isVoiceLine, ORDER_EXPIRY_MS, type CallLine } from "../../../shared/live-call";
import type { Message } from "@/state/store-types";
import { claimsDone, consentOf } from "./consent";
import type { LiveEngine, LiveEvents, LiveSession, LiveToolCall } from "./engine";

export const MIC_BLOCKED = "Microphone blocked";

export type CallStatus = "starting" | "needsKey" | "listening" | "speaking" | "working" | "ended" | "failed";
export type CallState = {
  status: CallStatus;
  startedAt?: number;
  muted: boolean;
  pending?: { order: string; expiresAt: number };
  error?: string;
  /** The line being spoken, kept after its turn until the next one starts. */
  caption?: { id: number; who: CallLine["who"]; text: string };
};

export type CallAudioPort = {
  capture(onFrame: (pcm: ArrayBuffer) => void): Promise<void>;
  play(pcm: Int16Array): void;
  flush(): void;
  close(): void;
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
  propose_work: (call, args, id) => call.propose(String(args.order ?? "").trim(), id),
};

const HANGUL = /[가-힣]/g;
const LETTER = /\p{L}/gu;
const MAX_RECONNECTS = 3;
const REPORT_CHARS = 1_500;

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
  private writes = new Set<Promise<unknown>>();
  private handle?: string;
  private connected = false;
  private reconnecting = 0;
  private heardBuf = "";
  private saidBuf = "";
  private lines = 0;
  private lineIds: Record<CallLine["who"], number> = { user: 0, voice: 0 };
  private guarded = false;
  private pending?: { order: string; toolId: string; timer: ReturnType<typeof setTimeout> };
  private awaiting = false;
  private busy = false;
  private reported = new Set<string>();
  private toldNeeds = new Set<string>();
  private spokeAt = 0;
  private turnHadAudio = false;
  private held = "";
  private letters = { hangul: 0, all: 0 };
  private stats = {
    turns: 0, userLines: 0, voiceLines: 0, interrupted: 0, doneGuard: 0, reconnects: 0,
    orders: { proposed: 0, confirmed: 0, declined: 0, expired: 0 },
    hidden: { spans: 0, ms: 0 }, closeCodes: [] as number[], ttfa: [] as number[], usage: 0,
  };
  private hiddenAt = 0;

  constructor(deps: Deps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    deps.audio.onStart = () => {
      if (!this.turnHadAudio && this.spokeAt) this.stats.ttfa.push(this.now() - this.spokeAt);
      this.spokeAt = 0;
      this.turnHadAudio = true;
      this.refresh();
    };
    deps.audio.onIdle = () => {
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
    const next: CallStatus = this.deps.audio.playing ? "speaking" : this.awaiting || this.busy ? "working" : "listening";
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
      return this.fail(error instanceof Error && error.name === "NotAllowedError" ? MIC_BLOCKED : String(error));
    }
    if (this.ended) return;
    this.set({ startedAt: this.now() });
    this.connect(session);
  }

  private async token(resume: boolean): Promise<LiveSession | null> {
    let posted: Posted;
    try {
      posted = await this.deps.post(`/api/bots/${encodeURIComponent(this.deps.botId)}/call/token`, this.callId ? { callId: this.callId, resume } : {});
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
    return { url: posted.data.url, token: posted.data.token, model: posted.data.model, ...(resume && this.handle ? { handle: this.handle } : {}) };
  }

  private connect(session: LiveSession) {
    const engine = this.deps.engine();
    this.engine = engine;
    const mine = () => this.engine === engine && !this.ended;
    const events: LiveEvents = {
      ready: () => {
        if (!mine()) return;
        this.connected = true;
        const resumed = Boolean(session.handle);
        this.reconnecting = 0;
        this.refresh();
        if (this.snapshot.status === "starting") this.set({ status: "listening" });
        if (!resumed) engine.sendText("[Wink] The call just started. Greet the user in one short sentence.");
      },
      audio: (pcm) => { if (mine()) this.deps.audio.play(pcm); },
      heard: (text) => {
        if (!mine()) return;
        this.heardBuf += text;
        this.caption("user", this.heardBuf);
      },
      said: (text) => {
        if (!mine()) return;
        this.saidBuf += text;
        this.caption("voice", this.saidBuf);
        if (this.awaiting && !this.guarded && claimsDone(this.saidBuf)) {
          this.guarded = true;
          this.stats.doneGuard += 1;
          engine.sendText(`[Wink] Not done yet: ${this.deps.botName} is still working.`);
        }
      },
      answering: () => { if (mine()) this.flushHeard(); },
      turnDone: () => {
        if (!mine()) return;
        this.stats.turns += 1;
        this.flushHeard();
        this.flushSaid(1);
        this.turnHadAudio = false;
        this.guarded = false;
        this.release();
      },
      interrupted: () => {
        if (!mine()) return;
        this.stats.interrupted += 1;
        const share = this.deps.audio.heardShare();
        this.deps.audio.flush();
        this.flushSaid(share);
        this.turnHadAudio = false;
        this.guarded = false;
      },
      toolCall: (calls) => { if (mine()) for (const call of calls) this.runTool(call); },
      toolCancel: (ids) => {
        if (mine() && this.pending && ids.includes(this.pending.toolId)) this.clearPending();
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

  propose(order: string, toolId: string) {
    if (!order) return this.engine?.sendToolResult(toolId, "propose_work", "declined");
    if (this.pending) this.answerTool("declined");
    this.stats.orders.proposed += 1;
    const expiresAt = this.now() + ORDER_EXPIRY_MS;
    const timer = setTimeout(() => {
      if (this.pending?.toolId !== toolId) return;
      this.stats.orders.expired += 1;
      this.answerTool("expired");
    }, ORDER_EXPIRY_MS);
    this.pending = { order, toolId, timer };
    this.set({ pending: { order, expiresAt } });
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
    this.engine?.sendToolResult(pending.toolId, "propose_work", result);
  }

  /** Yes or No on the pending order, tapped or spoken. */
  async answer(yes: boolean) {
    const pending = this.pending;
    if (!pending) return;
    if (!yes) {
      this.stats.orders.declined += 1;
      return this.answerTool("declined");
    }
    this.clearPending();
    this.stats.orders.confirmed += 1;
    let result: string;
    try {
      const sent = await this.deps.post(`/api/bots/${encodeURIComponent(this.deps.botId)}/messages`, {
        text: pending.order,
        sendId: crypto.randomUUID(),
        call: { id: this.callId, order: true },
      });
      if (sent.status >= 400) throw new Error(String(sent.data.error ?? sent.status));
      result = sent.data.queued ? "queued" : "sent";
      this.awaiting = true;
      this.refresh();
    } catch (error) {
      result = `failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.engine?.sendToolResult(pending.toolId, "propose_work", result);
  }

  private caption(who: CallLine["who"], buf: string) {
    const text = spokenText(buf);
    if (!text) return;
    this.lineIds[who] ||= ++this.lines;
    this.set({ caption: { id: this.lineIds[who], who, text } });
  }

  private flushHeard() {
    const text = spokenText(this.heardBuf);
    this.heardBuf = "";
    this.lineIds.user = 0;
    if (!text) return;
    this.stats.userLines += 1;
    this.letters.hangul += text.match(HANGUL)?.length ?? 0;
    this.letters.all += text.match(LETTER)?.length ?? 0;
    this.postLines([{ who: "user", text, at: this.now() }]);
    if (!this.pending) return;
    const consent = consentOf(text);
    if (consent) void this.answer(consent === "yes");
  }

  private flushSaid(share: number) {
    const full = spokenText(this.saidBuf);
    this.saidBuf = "";
    this.lineIds.voice = 0;
    if (!full) return;
    const text = share < 1 ? `${full.slice(0, Math.max(1, Math.round(full.length * share))).trimEnd()}…` : full;
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

  /** The chat as the store has it: relays the bot's settled reply and anything waiting on the user. */
  observe(input: { busy: boolean; messages: Message[]; needs?: { id: string; short: string } }) {
    this.busy = input.busy;
    const startedAt = this.snapshot.startedAt;
    if (!this.connected || startedAt === undefined || this.ended) return this.refresh();
    if (!input.busy) {
      const fresh = input.messages.filter((row) => row.role === "bot" && row.kind === "text" && !isVoiceLine(row) && !row.quick && row.at >= startedAt && row.text?.trim() && !this.reported.has(row.id));
      for (const row of fresh) this.reported.add(row.id);
      const reply = fresh.at(-1);
      if (reply) void this.report(reply.text!);
    }
    if (input.needs && !this.toldNeeds.has(input.needs.id)) {
      this.toldNeeds.add(input.needs.id);
      this.engine?.sendText(`[Wink] ${this.deps.botName} needs you in chat: ${input.needs.short}`);
    }
    this.refresh();
  }

  private async report(text: string) {
    this.awaiting = false;
    let speakable = text.slice(0, REPORT_CHARS);
    try {
      const prepared = await this.deps.post("/api/tts/prepare", { text: speakable });
      const utterances = prepared.data.utterances;
      if (Array.isArray(utterances) && utterances.length) speakable = utterances.join(" ");
    } catch {
      // the raw text still reads
    }
    if (this.ended) return;
    this.held = `[Wink] ${this.deps.botName} replied: ${speakable}`;
    this.release();
  }

  // Text sent while the voice talks cuts it off mid-word, so the report waits for the turn to end.
  private release() {
    if (!this.held || this.turnHadAudio || this.deps.audio.playing) return;
    this.engine?.sendText(this.held);
    this.held = "";
  }

  mute(muted: boolean) {
    this.set({ muted });
    if (muted) this.engine?.audioPaused();
  }

  hidden(isHidden: boolean) {
    if (isHidden) {
      this.hiddenAt = this.now();
      this.stats.hidden.spans += 1;
    } else if (this.hiddenAt) {
      this.stats.hidden.ms += this.now() - this.hiddenAt;
      this.hiddenAt = 0;
    }
  }

  private fail(error: string) {
    this.teardown();
    this.set({ status: "failed", error });
  }

  end() {
    if (this.snapshot.status === "ended") return;
    if (this.snapshot.status !== "failed") this.teardown();
    this.set({ status: "ended" });
  }

  private teardown() {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = undefined;
    const engine = this.engine;
    this.engine = null;
    this.connected = false;
    if (engine) {
      this.flushHeard();
      this.flushSaid(this.deps.audio.heardShare());
    }
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
        usage: { total: usage },
      },
    };
    // The server recaps the call on end, so the last lines must land first.
    void Promise.all([...this.writes]).then(() => this.deps.post(`/api/bots/${encodeURIComponent(this.deps.botId)}/call/end`, body)).catch(() => {});
  }
}
