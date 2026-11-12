import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Mic, MicOff, PhoneOff } from "lucide-react";

import { useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { useActiveCall, useCallChatShown } from "@/lib/live-call/active";
import { BotAvatar } from "./Avatar";
import { clock, noticeText, OrderCard, useLive, WORDS } from "./LiveCallBar";

/** The live call outside its own chat: tap to go back, mute, hang up, and answer an order. */
export function CallWidget({ narrow = false, className }: { narrow?: boolean; className?: string }) {
  const active = useActiveCall();
  const live = useLive(active?.botId ?? "");
  const inChat = useCallChatShown();
  const { state, dispatch } = useStore();
  const { locale } = useI18n();
  const words = WORDS[locale] ?? WORDS.en;
  const bot = active && (state.bots.find((candidate) => candidate.id === active.botId) ?? active.bot);
  const snap = useSyncExternalStore(live?.call.subscribe ?? noop, () => live?.call.state(), () => undefined);
  const [now, setNow] = useState(() => Date.now());
  const box = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ left?: number; right?: number; bottom: number } | null>(null);
  const shown = Boolean(live && bot && snap && !inChat);
  const pending = shown && Boolean(snap?.pending);
  const notice = shown && snap?.notice ? noticeText(snap.notice, locale) : "";

  useEffect(() => {
    if (!shown || !snap?.startedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [shown, snap?.startedAt]);

  // The icons-only sidebar has no room for the order, so it opens beside it.
  useLayoutEffect(() => {
    if (!narrow || !(pending || notice) || !box.current) return setAnchor(null);
    const rect = box.current.getBoundingClientRect();
    const bottom = window.innerHeight - rect.bottom;
    setAnchor(rect.left > window.innerWidth / 2 ? { right: window.innerWidth - rect.left + 8, bottom } : { left: rect.right + 8, bottom });
  }, [narrow, pending, notice]);

  if (!shown || !live || !bot || !snap) return null;
  const { call } = live;
  const talking = snap.status === "listening" || snap.status === "speaking" || snap.status === "working";
  const open = () => dispatch({ type: "select", id: bot.id });
  const label = words.openCall.replace("{bot}", () => bot.name);
  const icon = "flex size-8 shrink-0 items-center justify-center rounded-full max-md:size-10";
  const dot = (
    <span
      data-call-dot={snap.status}
      aria-hidden
      className={cn("size-2 shrink-0 rounded-full", snap.status === "speaking" ? "animate-pulse bg-accent motion-reduce:animate-none" : talking ? "bg-success" : "bg-ink-secondary/50")}
    />
  );
  const note = notice && <p data-live-call-notice={snap.notice?.kind} role="status" className="px-1 pb-1.5 text-xs text-ink-secondary">{notice}</p>;
  const hangUp = (
    <button type="button" aria-label={words.end} title={words.end} onClick={() => call.end()} className={cn(icon, "bg-danger text-white hover:brightness-110")}>
      <PhoneOff size={16} />
    </button>
  );

  if (narrow) {
    return (
      <div ref={box} data-call-widget={snap.status} className={cn("flex flex-col items-center gap-1 py-1", className)}>
        <button type="button" aria-label={label} title={label} onClick={open} className="relative rounded-full p-1 hover:bg-raised">
          <BotAvatar bot={bot} size={28} />
          <span className="absolute bottom-0.5 right-0.5 flex rounded-full bg-panel p-0.5">{dot}</span>
        </button>
        {hangUp}
        {(pending || notice) && anchor && createPortal(
          <div data-call-widget-order className="fixed z-40 w-72" style={anchor}>
            {pending ? <OrderCard bot={bot} live={live} narrow /> : <div className="rounded-xl border border-hairline/50 bg-card p-2 shadow-sm">{note}</div>}
          </div>,
          document.body,
        )}
      </div>
    );
  }

  return (
    <div data-call-widget={snap.status} className={className}>
      {pending && <OrderCard bot={bot} live={live} narrow />}
      {note}
      <div className="flex min-w-0 items-center gap-1 rounded-xl border border-hairline/50 bg-card py-1 pl-1 pr-1.5 shadow-sm">
        <button type="button" aria-label={label} title={label} onClick={open} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-raised max-md:min-h-10">
          <BotAvatar bot={bot} size={24} />
          <span className="min-w-0 truncate text-[13px] font-medium text-ink">{bot.name}</span>
          {dot}
          <span className="sr-only">{words[snap.status]}</span>
          {snap.startedAt !== undefined && <span className="shrink-0 text-[12px] tabular-nums text-ink-secondary">{clock(now - snap.startedAt)}</span>}
        </button>
        {talking && (
          <button type="button" aria-pressed={snap.muted} aria-label={snap.muted ? words.unmute : words.mute} title={snap.muted ? words.unmute : words.mute} onClick={() => call.mute(!snap.muted)} className={cn(icon, snap.muted ? "bg-control text-ink" : "text-ink-secondary hover:bg-control hover:text-ink")}>
            {snap.muted ? <MicOff size={16} /> : <Mic size={16} />}
          </button>
        )}
        {hangUp}
      </div>
    </div>
  );
}

const noop = () => () => {};
