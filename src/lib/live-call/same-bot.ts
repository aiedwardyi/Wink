// A same-bot call: his words go to the bot as a chat message, and the bot's own reply is read out. Gemini Live is only the ears and the mouth.
import { toUtterances } from "../../../server/tts/speech-text.ts";
import { callPace, isVoiceLine, spokenText, type CallPrefs } from "../../../shared/live-call";
import { activeLocale } from "@/lib/i18n";
import { isShownMessage } from "@/lib/shown-message";
import type { Message } from "@/state/store-types";
import { MIC_BLOCKED, MIC_BUSY, MIC_MISSING, VOICE_OUT, type CallAudioPort, type CallState, type Posted } from "./controller";
import type { LiveEngine, LiveEvents, LiveSession } from "./engine";

const MIC_ERRORS: Record<string, string> = { NotAllowedError: MIC_BLOCKED, NotFoundError: MIC_MISSING, OverconstrainedError: MIC_MISSING, NotReadableError: MIC_BUSY };
const QUOTA = /quota|resource.?exhausted/i;
const MAX_RECONNECTS = 3;
const READ = "[READ]\n";
// A mutter is not a message to the bot; a yes or a no is.
const MUTTER = /^(?:h?m+|mhm|u[hm]+|uh-?huh|er+|음+|어+)[.!?,\s]*$/i;

function loud(pcm: ArrayBuffer): boolean {
  for (const sample of new Int16Array(pcm)) if (sample > 1_000 || sample < -1_000) return true;
  return false;
}

type Deps = {
  botId: string;
  engine: () => LiveEngine;
  audio: CallAudioPort;
  post: (path: string, body: object) => Promise<Posted>;
  /** The same send a typed message takes. */
  send: (text: string) => void;
  prefs?: CallPrefs;
  now?: () => number;
};

export class SameBotCall {
  private readonly deps: Deps;
  private readonly now: () => number;
  private listeners = new Set<() => void>();
  private snapshot: CallState = { status: "starting", muted: false };
  private engine: LiveEngine | null = null;
  private connected = false;
  private callId?: string;
  private handle?: string;
  private reconnects = 0;
  private stalled = false;
  private busy = false;
  /** Sent to the bot, its reply not read yet. */
  private waiting = false;
  private seen?: Set<string>;
  private heard = "";
  private said = "";
  /** Whose words the voice is answering: his (never played) or a [READ] it was sent. */
  private turn: "user" | "read" | null = null;
  private asked = false;
  private reads: string[] = [];
  /** Tapped to stop: the rest of the read turn never plays. */
  private cut = false;
  private micOpen = false;
  private loudAt = 0;
  private spokeAt = 0;
  private captions = 0;
  readonly firstWordMs: number[] = [];

  constructor(deps: Deps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    deps.audio.onStart = () => {
      if (this.spokeAt) this.firstWordMs.push(this.now() - this.spokeAt);
      this.spokeAt = 0;
      this.refresh();
    };
    deps.audio.onIdle = () => this.refresh();
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

  private get ended() {
    return this.snapshot.status === "ended" || this.snapshot.status === "failed";
  }

  /** Half-duplex: while a reply is read the mic sends nothing, so the voice never hears itself. */
  private get speaking() {
    return this.deps.audio.playing || (!this.cut && (this.turn === "read" || this.asked || this.reads.length > 0));
  }

  private refresh() {
    const { status } = this.snapshot;
    if (status === "ended" || status === "failed" || status === "needsKey" || status === "starting") return;
    const next = this.stalled ? "paused" : this.speaking ? "speaking" : this.busy || this.waiting ? "working" : "listening";
    if (next !== status) this.set({ status: next });
  }

  async start() {
    this.set({ status: "starting", error: undefined });
    const mic = this.deps.audio.capture((pcm) => this.frame(pcm)).then((played) => {
      if (played === false) {
        this.stalled = true;
        this.set({ noSound: true });
      }
      return null;
    }, (error) => error ?? new Error("mic failed"));
    const session = await this.token();
    if (!session) {
      void mic.then(() => { if (!this.connected) this.deps.audio.stopMic(); });
      return;
    }
    const error = await mic;
    if (this.ended) return;
    if (error) return this.fail((error instanceof Error && MIC_ERRORS[error.name]) || String(error));
    this.set({ startedAt: this.now() });
    this.connect(session);
  }

  private async token(): Promise<LiveSession | null> {
    let posted: Posted;
    try {
      posted = await this.deps.post(`/api/bots/${encodeURIComponent(this.deps.botId)}/call/token`, { locale: activeLocale(), mode: "bot", call: this.deps.prefs, ...(this.callId ? { callId: this.callId, resume: true } : {}) });
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      return null;
    }
    if (posted.status === 409 && !this.callId) {
      this.set({ status: "needsKey" });
      return null;
    }
    if (posted.status === 429) {
      this.fail(VOICE_OUT);
      return null;
    }
    if (posted.status !== 200) {
      this.fail(String(posted.data.error ?? `call failed (${posted.status})`));
      return null;
    }
    this.callId = posted.data.callId;
    return { url: posted.data.url, token: posted.data.token, model: posted.data.model, voice: posted.data.voice, ...(this.handle ? { handle: this.handle } : {}) };
  }

  private connect(session: LiveSession) {
    const engine = this.deps.engine();
    this.engine = engine;
    engine.connect(session, this.events(engine));
  }

  private frame(pcm: ArrayBuffer) {
    if (!this.connected || this.snapshot.muted) return;
    if (this.speaking) {
      if (this.micOpen) this.engine?.audioPaused();
      this.micOpen = false;
      return;
    }
    this.micOpen = true;
    if (loud(pcm)) this.loudAt = this.now();
    this.engine?.sendAudio(pcm);
  }

  private events(engine: LiveEngine): LiveEvents {
    const mine = () => this.engine === engine && !this.ended;
    return {
      ready: () => {
        if (!mine()) return;
        this.connected = true;
        this.reconnects = 0;
        if (this.snapshot.status === "starting") this.set({ status: "listening" });
        this.refresh();
        this.readNext();
      },
      audio: (pcm) => {
        if (mine() && this.turn === "read" && !this.cut) this.deps.audio.play(pcm);
      },
      heard: (text) => {
        if (!mine() || this.speaking) return;
        this.heard += text;
        this.caption("user", this.heard);
      },
      said: (text) => {
        if (!mine() || this.turn !== "read" || this.cut) return;
        this.said += text;
        this.caption("voice", this.said);
      },
      answering: () => {
        if (!mine()) return;
        this.turn = this.asked ? "read" : "user";
        this.asked = false;
      },
      turnDone: () => {
        if (!mine()) return;
        if (this.turn === "read") this.deps.audio.endTurn();
        else this.commit();
        this.turn = null;
        this.said = "";
        this.cut = false;
        this.readNext();
        this.refresh();
      },
      interrupted: () => {
        if (!mine()) return;
        if (this.turn === "read") this.deps.audio.flush();
        this.turn = null;
        this.refresh();
      },
      toolCall: () => {},
      toolCancel: () => {},
      resumable: (handle) => { if (mine()) this.handle = handle; },
      goAway: () => { if (mine()) void this.reconnect(); },
      usage: () => {},
      closed: (_code, reason) => {
        if (this.engine !== engine || this.ended) return;
        if (QUOTA.test(reason)) return this.fail(VOICE_OUT);
        void this.reconnect();
      },
    };
  }

  private caption(who: "user" | "voice", text: string) {
    const words = spokenText(text);
    if (!words) return;
    const last = this.snapshot.caption;
    this.set({ caption: { id: last?.who === who ? last.id : ++this.captions, who, text: words } });
  }

  /** His line is whole once the voice's turn for it ends: it goes to the bot exactly like a typed message. */
  private commit() {
    const text = spokenText(this.heard);
    this.heard = "";
    if (!text || MUTTER.test(text)) return;
    this.waiting = true;
    this.spokeAt = this.loudAt;
    this.deps.send(text);
  }

  /** The bot's own reply, read once its turn settles; anything already in the chat at the start stays unread. */
  observe({ busy, messages }: { busy: boolean; messages: Message[] }) {
    this.busy = busy;
    if (!this.seen) this.seen = new Set(messages.map((message) => message.id));
    else if (!busy) {
      const fresh = messages.filter((message) => !this.seen!.has(message.id) && isShownMessage(message));
      for (const message of fresh) this.seen.add(message.id);
      const reply = [...fresh].reverse().find((message) => message.role === "bot" && message.kind === "text" && !isVoiceLine(message) && message.text?.trim());
      if (fresh.some((message) => message.role !== "user")) this.waiting = false;
      if (reply?.text) this.read(reply.text);
    }
    this.refresh();
  }

  private read(text: string) {
    this.reads.push(...toUtterances(text));
    this.readNext();
  }

  // One utterance per voice turn: the next goes out when the last is generated, so it queues behind the words still playing.
  private readNext() {
    if (!this.engine || !this.connected || this.turn || this.asked || spokenText(this.heard)) return;
    const next = this.reads.shift();
    if (!next) return;
    this.asked = true;
    this.engine.sendText(`${READ}${next}`);
    this.refresh();
  }

  /** A tap while it reads: the rest is dropped and the mic opens. */
  interrupt() {
    if (!this.speaking) return;
    this.reads = [];
    this.cut = this.turn === "read" || this.asked;
    this.deps.audio.flush();
    this.refresh();
  }

  retune(prefs: CallPrefs, volume = 1) {
    this.deps.audio.tune(callPace(prefs), volume);
  }

  mute(muted: boolean) {
    this.set({ muted });
    if (muted && this.micOpen) this.engine?.audioPaused();
    this.micOpen = false;
  }

  hidden(isHidden: boolean) {
    if (!isHidden) void this.heal();
  }

  resume() {
    void this.heal();
  }

  private async heal() {
    if (this.ended || this.snapshot.startedAt === undefined) return;
    const ok = await this.deps.audio.heal();
    if (this.ended) return;
    this.stalled = !ok;
    if (ok && this.snapshot.noSound) this.set({ noSound: undefined });
    this.refresh();
  }

  private async reconnect() {
    const old = this.engine;
    this.engine = null;
    this.connected = false;
    this.turn = null;
    this.asked = false;
    old?.close();
    if (this.ended) return;
    if (!this.handle || this.reconnects >= MAX_RECONNECTS) return this.fail("The call dropped");
    this.reconnects += 1;
    const session = await this.token();
    if (session && !this.ended) this.connect(session);
  }

  private fail(error: string) {
    if (this.ended) return;
    this.teardown();
    this.set({ status: "failed", error });
  }

  end() {
    if (this.snapshot.status === "ended") return;
    if (this.snapshot.status !== "failed") {
      if (this.connected && !this.snapshot.muted) this.deps.audio.boop();
      this.teardown();
    }
    this.set({ status: "ended" });
  }

  private teardown() {
    const engine = this.engine;
    this.engine = null;
    this.connected = false;
    this.reads = [];
    engine?.close();
    this.deps.audio.close();
    const started = this.snapshot.startedAt;
    if (this.callId && started !== undefined) {
      const sorted = [...this.firstWordMs].sort((a, b) => a - b);
      const at = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! : null);
      void this.deps.post(`/api/bots/${encodeURIComponent(this.deps.botId)}/call/end`, { callId: this.callId, stats: { ms: Math.max(0, this.now() - started), ttfaMs: { p50: at(0.5), p90: at(0.9) } } }).catch(() => {});
    }
  }
}
