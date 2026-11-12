import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useStore, visibleMessages, type Bot } from "@/state/store";
import { fetchResponse, responseBody } from "@/lib/api-request";
import { endCall, startCall, useOnCall } from "@/lib/call";
import { cn } from "@/lib/cn";
import { useI18n, type LocaleId } from "@/lib/i18n";
import { dropCall, useActiveCall, type ActiveCall } from "@/lib/live-call/active";
import { CallAudio } from "@/lib/live-call/audio";
import { LiveCall, MIC_BLOCKED, MIC_BUSY, MIC_MISSING, type CallState, type CallStatus, type Posted } from "@/lib/live-call/controller";
import { GeminiLive } from "@/lib/live-call/gemini";
import { usePresence } from "@/lib/use-presence";
import { firstNeed } from "../../shared/call-status";
import { ORDER_EXPIRY_MS } from "../../shared/live-call";
import { CallIntro, seenIntro } from "./CallIntro";
import { Fold } from "./Fold";

const PRIVACY_SEEN = "wink.liveCall.privacyNote";

export const WORDS: Record<LocaleId, Record<CallStatus | "send" | "yes" | "no" | "notSent" | "noReply" | "mute" | "unmute" | "end" | "privacy" | "captions" | "you" | "micBlocked" | "micMissing" | "micBusy" | "openSettings" | "openCall", string>> = {
  en: {
    starting: "Connecting…",
    needsKey: "Add a Gemini key in the chat to call.",
    listening: "Listening",
    speaking: "Speaking",
    working: "Working",
    ended: "Call ended",
    failed: "Call failed",
    send: "Ask {bot} to do this?",
    yes: "Yes",
    no: "No",
    notSent: "Not sent",
    noReply: "No reply",
    mute: "Mute",
    unmute: "Unmute",
    end: "End",
    privacy: "Free Gemini: Google may use call audio to improve its products.",
    captions: "Captions",
    you: "You",
    micBlocked: "Microphone is off for Wink.",
    micMissing: "No microphone found. Plug one in, or type in the chat instead.",
    micBusy: "Your microphone is in use by another app.",
    openSettings: "Open settings",
    openCall: "Back to the call with {bot}",
  },
  ko: {
    starting: "연결 중…",
    needsKey: "통화하려면 채팅에 Gemini 키를 추가하세요.",
    listening: "듣는 중",
    speaking: "말하는 중",
    working: "작업 중",
    ended: "통화 종료",
    failed: "통화 실패",
    send: "{bot}에게 이렇게 요청할까요?",
    yes: "예",
    no: "아니요",
    notSent: "보내지 않음",
    noReply: "답 없음",
    mute: "음소거",
    unmute: "음소거 해제",
    end: "종료",
    privacy: "무료 Gemini: Google이 통화 음성을 제품 개선에 사용할 수 있습니다.",
    captions: "자막",
    you: "나",
    micBlocked: "Wink에서 마이크가 꺼져 있습니다.",
    micMissing: "마이크를 찾을 수 없습니다. 마이크를 연결하거나 채팅으로 입력하세요.",
    micBusy: "다른 앱에서 마이크를 사용 중입니다.",
    openSettings: "설정 열기",
    openCall: "{bot} 통화로 돌아가기",
  },
};

// Known outcome reasons; anything else (a server error) shows as sent.
const REASONS: Record<LocaleId, Record<string, string>> = {
  en: {},
  ko: { declined: "거절됨", expired: "시간 초과", replaced: "다른 요청으로 바뀜", "needs a yes": "확인 필요" },
};

export function noticeText(notice: NonNullable<CallState["notice"]>, locale: LocaleId): string {
  const words = WORDS[locale] ?? WORDS.en;
  return `${words[notice.kind]}: ${notice.text}${notice.why ? ` (${REASONS[locale]?.[notice.why] ?? notice.why})` : ""}`;
}

async function post(path: string, body: object): Promise<Posted> {
  const res = await fetchResponse(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, data: ((await responseBody(res)) ?? {}) as Record<string, any> };
}

function seenPrivacy(): boolean {
  try {
    return Boolean(localStorage.getItem(PRIVACY_SEEN));
  } catch {
    return false;
  }
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export type Live = { call: LiveCall; level: (mic: boolean) => number };

// The box controls live in the composer, which remounts on a task switch; the call must not.
const lives = new Map<string, Live>();
const watchers = new Set<() => void>();

function publish(botId: string, live: Live | undefined) {
  if (live) lives.set(botId, live);
  else lives.delete(botId);
  for (const fn of [...watchers]) fn();
}

function watch(fn: () => void) {
  watchers.add(fn);
  return () => { watchers.delete(fn); };
}

export function useLive(botId: string): Live | undefined {
  return useSyncExternalStore(watch, () => lives.get(botId), () => undefined);
}

// Time, not decoration: it runs under reduced motion too.
function TimeLeft({ expiresAt }: { expiresAt: number }) {
  const [elapsed] = useState(() => Math.max(0, ORDER_EXPIRY_MS - (expiresAt - Date.now())));
  return (
    <div
      data-live-call-time-left
      data-progress
      className="h-0.5 origin-left bg-accent/60"
      style={{ animation: `call-time-left ${ORDER_EXPIRY_MS}ms linear -${elapsed}ms forwards` }}
    />
  );
}

/** Owns the live call above every view, so switching chats or opening a room never ends it. */
export function LiveCallHost() {
  const active = useActiveCall();
  const { state } = useStore();
  const bot = active && (state.bots.find((candidate) => candidate.id === active.botId) ?? active.bot);
  return active && bot ? <Session key={active.id} active={active} bot={bot} /> : null;
}

function Session({ active, bot }: { active: ActiveCall; bot: Bot }) {
  const { state } = useStore();
  const { locale } = useI18n();
  const words = WORDS[locale] ?? WORDS.en;
  const onEnd = useCallback((note?: string) => dropCall(active, note), [active]);
  const [live] = useState((): Live => {
    const audio = new CallAudio(active.ctx);
    const call = new LiveCall({
      botId: bot.id,
      botName: bot.name,
      device: matchMedia("(pointer: coarse)").matches ? "phone" : "desktop",
      engine: () => new GeminiLive(),
      audio,
      post,
    });
    return { call, level: (mic) => audio.level(mic) };
  });
  const { call } = live;
  const snap = useSyncExternalStore(call.subscribe, call.state, call.state);
  const owner = useOnCall();
  const mounted = useRef(false);
  const kicked = useRef(false);
  const configured = Boolean(state.config?.gemini?.configured);
  const [fresh, setFresh] = useState(() => !seenIntro());
  // A key saved mid-call shows the intro too, so the call never goes live unseen.
  const intro = (fresh && configured && !state.config?.gemini?.introSeen) || (snap.status === "needsKey" && configured);
  const introShown = usePresence(intro);
  const messages = visibleMessages(bot);

  useEffect(() => {
    if (intro) return;
    publish(bot.id, live);
    return () => publish(bot.id, undefined);
  }, [bot.id, intro, live]);

  useEffect(() => {
    if (!state.config || kicked.current) return;
    kicked.current = true;
    if (!intro) void call.start();
  }, [call, intro, state.config]);

  useEffect(() => {
    mounted.current = true;
    startCall(bot.id);
    const onVisible = () => call.hidden(document.hidden);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      mounted.current = false;
      document.removeEventListener("visibilitychange", onVisible);
      // StrictMode remounts at once; only a real unmount hangs up.
      queueMicrotask(() => {
        if (mounted.current) return;
        call.end();
        endCall(bot.id);
        onEnd();
      });
    };
  }, [bot.id, call, onEnd]);

  useEffect(() => {
    if (snap.status !== "ended" && (owner === null || owner === bot.id)) return;
    endCall(bot.id);
    onEnd();
  }, [bot.id, onEnd, owner, snap.status]);

  // No mic to fix in settings: hang up and leave only the line.
  const micGone = snap.status === "failed" && (snap.error === MIC_MISSING || snap.error === MIC_BUSY);
  useEffect(() => {
    if (!micGone) return;
    endCall(bot.id);
    onEnd(snap.error === MIC_MISSING ? words.micMissing : words.micBusy);
  }, [bot.id, micGone, onEnd, snap.error, words]);

  useEffect(() => {
    call.observe({ busy: Boolean(bot.busy), messages, threadId: bot.threadId, needs: firstNeed(messages) });
  }, [bot.busy, bot.threadId, call, messages]);

  return introShown.mounted ? <CallIntro closing={introShown.closing} onStart={() => { setFresh(false); void call.start(); }} onLater={() => onEnd()} /> : null;
}

const TARGET = "inline-flex min-h-9 items-center justify-center rounded-full px-4 text-sm font-medium max-md:min-h-12 max-md:flex-1";

export function OrderCard({ bot, live, narrow = false }: { bot: Bot; live: Live; narrow?: boolean }) {
  const { locale } = useI18n();
  const words = WORDS[locale] ?? WORDS.en;
  const { call } = live;
  const snap = useSyncExternalStore(call.subscribe, call.state, call.state);
  return (
    <div data-live-call-order className="mb-2 overflow-hidden rounded-2xl border border-hairline/50 bg-card shadow-sm">
      {snap.pending && <TimeLeft key={snap.pending.expiresAt} expiresAt={snap.pending.expiresAt} />}
      <div className={cn("flex items-center gap-2 p-3", narrow ? "flex-wrap" : "max-md:flex-wrap")}>
        <div className={cn("min-w-0 flex-1 text-sm text-ink", narrow ? "basis-full" : "max-md:basis-full")}>
          <p>{words.send.replace("{bot}", bot.name)}</p>
          <p className="font-medium">{snap.pending?.order}</p>
        </div>
        <button type="button" onClick={() => void call.answer(true)} className={cn(TARGET, "bg-accent text-accent-ink", narrow && "flex-1")}>{words.yes}</button>
        <button type="button" onClick={() => void call.answer(false)} className={cn(TARGET, "bg-control text-ink", narrow && "flex-1")}>{words.no}</button>
      </div>
    </div>
  );
}

/** The call's notes and order card in its own chat. */
export function LiveCallBar({ bot }: { bot: Bot }) {
  const live = useLive(bot.id);
  return live ? <Bar bot={bot} live={live} /> : null;
}

function Bar({ bot, live }: { bot: Bot; live: Live }) {
  const { locale } = useI18n();
  const words = WORDS[locale] ?? WORDS.en;
  const snap = useSyncExternalStore(live.call.subscribe, live.call.state, live.call.state);
  const [privacy] = useState(() => !seenPrivacy());
  const micBlocked = snap.status === "failed" && snap.error === MIC_BLOCKED;
  const note = snap.status === "needsKey" ? words.needsKey : micBlocked ? words.micBlocked : snap.status === "failed" ? (snap.error ? `${words.failed}: ${snap.error}` : words.failed) : snap.notice ? noticeText(snap.notice, locale) : privacy ? words.privacy : "";

  // Marked once shown, not at mount: a restarted render would hide it before anyone saw it.
  useEffect(() => {
    if (note !== words.privacy) return;
    try {
      localStorage.setItem(PRIVACY_SEEN, "1");
    } catch {
      // shown again next time
    }
  }, [note, words.privacy]);

  return (
    <div data-live-call={snap.status} className="px-5 max-md:px-3">
      <Fold open={Boolean(snap.pending)} soft keep>
        <OrderCard bot={bot} live={live} />
      </Fold>
      {note && (
        <p data-live-call-notice={snap.notice?.kind} role={snap.status === "failed" ? "alert" : snap.notice ? "status" : undefined} className="px-1 pb-2 text-xs text-ink-secondary">
          {note}
          {micBlocked && window.ogb?.permOpenSettings && (
            <button type="button" onClick={() => void window.ogb?.permOpenSettings("mic")} className="ml-2 font-medium text-accent hover:underline">{words.openSettings}</button>
          )}
        </p>
      )}
    </div>
  );
}
