import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Loader2, Mic, MicOff, PhoneOff } from "lucide-react";

import { useStore, visibleMessages, type Bot, type Message } from "@/state/store";
import { fetchResponse, responseBody } from "@/lib/api-request";
import { endCall, startCall, useOnCall } from "@/lib/call";
import { cn } from "@/lib/cn";
import { useI18n, type LocaleId } from "@/lib/i18n";
import { CallAudio } from "@/lib/live-call/audio";
import { LiveCall, type CallStatus, type Posted } from "@/lib/live-call/controller";
import { GeminiLive } from "@/lib/live-call/gemini";

const PRIVACY_SEEN = "wink.liveCall.privacyNote";

const WORDS: Record<LocaleId, Record<CallStatus | "send" | "yes" | "no" | "mute" | "unmute" | "end" | "privacy", string>> = {
  en: {
    starting: "Connecting…",
    needsKey: "Add a Gemini key in the chat to call.",
    listening: "Listening",
    speaking: "Speaking",
    working: "Working",
    ended: "Call ended",
    failed: "Call failed",
    send: "Send: {order}?",
    yes: "Yes",
    no: "No",
    mute: "Mute",
    unmute: "Unmute",
    end: "End",
    privacy: "Free Gemini: Google may use call audio to improve its products.",
  },
  ko: {
    starting: "연결 중…",
    needsKey: "통화하려면 채팅에 Gemini 키를 추가하세요.",
    listening: "듣는 중",
    speaking: "말하는 중",
    working: "작업 중",
    ended: "통화 종료",
    failed: "통화 실패",
    send: "{order} 보낼까요?",
    yes: "예",
    no: "아니요",
    mute: "음소거",
    unmute: "음소거 해제",
    end: "종료",
    privacy: "무료 Gemini: Google이 통화 음성을 제품 개선에 사용할 수 있습니다.",
  },
};

async function post(path: string, body: object): Promise<Posted> {
  const res = await fetchResponse(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, data: ((await responseBody(res)) ?? {}) as Record<string, any> };
}

function firstNeed(messages: Message[]): { id: string; short: string } | undefined {
  for (const row of messages) {
    const card = row.card;
    if (row.kind === "options" && card?.requestId && !card.answered && !card.dismissed) return { id: row.id, short: card.title || card.tool || "a question" };
    const secret = row.secret;
    if (row.kind === "secret" && secret && !secret.provided && !secret.dismissed && !secret.requestKey.startsWith("call-")) return { id: row.id, short: secret.label };
  }
  return undefined;
}

function seenPrivacy(): boolean {
  try {
    if (localStorage.getItem(PRIVACY_SEEN)) return true;
    localStorage.setItem(PRIVACY_SEEN, "1");
  } catch {
    // shown again next time
  }
  return false;
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function LiveCallBar({ bot, ctx, onEnd }: { bot: Bot; ctx: AudioContext; onEnd: () => void }) {
  const { state } = useStore();
  const { locale } = useI18n();
  const words = WORDS[locale] ?? WORDS.en;
  const [call] = useState(() => new LiveCall({
    botId: bot.id,
    botName: bot.name,
    device: matchMedia("(pointer: coarse)").matches ? "phone" : "desktop",
    engine: () => new GeminiLive(),
    audio: new CallAudio(ctx),
    post,
  }));
  const snap = useSyncExternalStore(call.subscribe, call.state, call.state);
  const [privacy] = useState(() => !seenPrivacy());
  const [now, setNow] = useState(() => Date.now());
  const owner = useOnCall();
  const mounted = useRef(false);
  const kicked = useRef(false);
  const configured = Boolean(state.config?.gemini?.configured);
  const messages = visibleMessages(bot);

  useEffect(() => {
    mounted.current = true;
    startCall(bot.id);
    if (!kicked.current) {
      kicked.current = true;
      void call.start();
    }
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
    if (snap.status === "needsKey" && configured) void call.start();
  }, [call, configured, snap.status]);

  useEffect(() => {
    if (snap.status === "ended" || (owner !== null && owner !== bot.id)) onEnd();
  }, [bot.id, onEnd, owner, snap.status]);

  useEffect(() => {
    call.observe({ busy: Boolean(bot.busy), messages, needs: firstNeed(messages) });
  }, [bot.busy, call, messages]);

  useEffect(() => {
    if (!snap.startedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [snap.startedAt]);

  const [sendBefore, sendAfter] = words.send.split("{order}");
  const live = snap.status === "listening" || snap.status === "speaking" || snap.status === "working";
  const label = snap.status === "failed" && snap.error ? `${words.failed}: ${snap.error}` : words[snap.status];
  const target = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full px-4 text-sm font-medium max-md:min-h-14 max-md:min-w-14";

  return (
    <div data-live-call={snap.status} className="px-5 pb-2 max-md:px-3">
      <div className="rounded-2xl border border-hairline/50 bg-card shadow-sm">
        {snap.pending && (
          <div data-live-call-order className="flex items-center gap-2 border-b border-hairline/50 p-3">
            <p className="min-w-0 flex-1 text-sm text-ink">
              {sendBefore}<span className="font-medium">{snap.pending.order.replace(/[.?!。]+$/, "")}</span>{sendAfter}
            </p>
            <button type="button" onClick={() => void call.answer(true)} className={cn(target, "bg-accent text-accent-ink")}>{words.yes}</button>
            <button type="button" onClick={() => void call.answer(false)} className={cn(target, "bg-control text-ink")}>{words.no}</button>
          </div>
        )}
        <div className="flex items-center gap-3 p-3">
          <span className={cn("size-2.5 shrink-0 rounded-full", live ? (snap.status === "speaking" ? "bg-accent" : "bg-success") : "bg-ink-secondary")} aria-hidden />
          {snap.status === "starting" && <Loader2 size={16} className="shrink-0 animate-spin text-ink-secondary" aria-hidden />}
          <p role="status" className="min-w-0 flex-1 truncate text-sm text-ink">
            {label}
            {snap.startedAt !== undefined && live && <span className="ml-2 tabular-nums text-ink-secondary">{clock(now - snap.startedAt)}</span>}
          </p>
          {live && (
            <button type="button" aria-pressed={snap.muted} onClick={() => call.mute(!snap.muted)} className={cn(target, "bg-control text-ink")}>
              {snap.muted ? <MicOff size={18} /> : <Mic size={18} />}
              <span className="max-md:sr-only">{snap.muted ? words.unmute : words.mute}</span>
            </button>
          )}
          <button type="button" onClick={() => call.end()} className={cn(target, "bg-danger text-white")}>
            <PhoneOff size={18} />
            <span className="max-md:sr-only">{words.end}</span>
          </button>
        </div>
        {privacy && <p className="px-3 pb-3 text-xs text-ink-secondary">{words.privacy}</p>}
      </div>
    </div>
  );
}
