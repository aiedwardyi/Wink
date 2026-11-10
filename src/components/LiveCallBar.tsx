import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useStore, visibleMessages, type Bot, type Message } from "@/state/store";
import { fetchResponse, responseBody } from "@/lib/api-request";
import { endCall, startCall, useOnCall } from "@/lib/call";
import { cn } from "@/lib/cn";
import { useI18n, type LocaleId } from "@/lib/i18n";
import { CallAudio } from "@/lib/live-call/audio";
import { LiveCall, type CallStatus, type Posted } from "@/lib/live-call/controller";
import { GeminiLive } from "@/lib/live-call/gemini";
import { ORDER_EXPIRY_MS } from "../../shared/live-call";
import { Fold } from "./Fold";

const PRIVACY_SEEN = "wink.liveCall.privacyNote";

export const WORDS: Record<LocaleId, Record<CallStatus | "send" | "yes" | "no" | "mute" | "unmute" | "end" | "privacy" | "captions" | "you", string>> = {
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
    captions: "Captions",
    you: "You",
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
    captions: "자막",
    you: "나",
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
      className="h-0.5 origin-left bg-accent/60"
      style={{ animation: `call-time-left ${ORDER_EXPIRY_MS}ms linear -${elapsed}ms forwards` }}
    />
  );
}

export function LiveCallBar({ bot, ctx, onEnd }: { bot: Bot; ctx: AudioContext; onEnd: () => void }) {
  const { state } = useStore();
  const { locale } = useI18n();
  const words = WORDS[locale] ?? WORDS.en;
  const [live] = useState((): Live => {
    const audio = new CallAudio(ctx);
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
  const [privacy] = useState(() => !seenPrivacy());
  const owner = useOnCall();
  const mounted = useRef(false);
  const kicked = useRef(false);
  const configured = Boolean(state.config?.gemini?.configured);
  const messages = visibleMessages(bot);

  useEffect(() => {
    publish(bot.id, live);
    return () => publish(bot.id, undefined);
  }, [bot.id, live]);

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

  const [sendBefore, sendAfter] = words.send.split("{order}");
  const note = snap.status === "needsKey" ? words.needsKey : snap.status === "failed" ? (snap.error ? `${words.failed}: ${snap.error}` : words.failed) : privacy ? words.privacy : "";
  const target = "inline-flex min-h-9 items-center justify-center rounded-full px-4 text-sm font-medium max-md:min-h-12 max-md:flex-1";

  return (
    <div data-live-call={snap.status} className="px-5 max-md:px-3">
      <Fold open={Boolean(snap.pending)} soft keep>
        <div data-live-call-order className="mb-2 overflow-hidden rounded-2xl border border-hairline/50 bg-card shadow-sm">
          {snap.pending && <TimeLeft key={snap.pending.expiresAt} expiresAt={snap.pending.expiresAt} />}
          <div className="flex items-center gap-2 p-3 max-md:flex-wrap">
            <p className="min-w-0 flex-1 text-sm text-ink max-md:basis-full">
              {sendBefore}<span className="font-medium">{snap.pending?.order.replace(/[.?!。]+$/, "")}</span>{sendAfter}
            </p>
            <button type="button" onClick={() => void call.answer(true)} className={cn(target, "bg-accent text-accent-ink")}>{words.yes}</button>
            <button type="button" onClick={() => void call.answer(false)} className={cn(target, "bg-control text-ink")}>{words.no}</button>
          </div>
        </div>
      </Fold>
      {note && <p role={snap.status === "failed" ? "alert" : undefined} className="px-1 pb-2 text-xs text-ink-secondary">{note}</p>}
    </div>
  );
}
