import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Captions, Loader2, Mic, MicOff, PhoneOff } from "lucide-react";

import type { Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import type { CallState } from "@/lib/live-call/controller";
import { reducedMotion } from "@/lib/phone-swipe";
import { clock, useLive, WORDS, type Live } from "./LiveCallBar";

const CAPTIONS = "wink.liveCall.captions";
const BARS = [0.55, 1, 0.75, 0.45];

function captionsOn(): boolean {
  try {
    return localStorage.getItem(CAPTIONS) === "1";
  } catch {
    return false;
  }
}

function VoiceBars({ live, muted }: { live: Live; muted: boolean }) {
  const bars = useRef<Array<HTMLSpanElement | null>>([]);
  const mic = useRef(!muted);
  mic.current = !muted;
  useEffect(() => {
    if (reducedMotion()) return;
    let frame = 0;
    let level = 0;
    const tick = () => {
      level += (live.level(mic.current) - level) * 0.35;
      bars.current.forEach((bar, i) => bar?.style.setProperty("transform", `scaleY(${0.2 + 0.8 * Math.min(1, level * BARS[i]!)})`));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [live]);
  return (
    <span data-voice-bars aria-hidden className="flex h-4 shrink-0 items-center gap-[3px]">
      {BARS.map((_, i) => (
        <span key={i} ref={(el) => { bars.current[i] = el; }} className="h-full w-[3px] rounded-full bg-accent" style={{ transform: "scaleY(0.2)" }} />
      ))}
    </span>
  );
}

function CaptionLine({ caption, who }: { caption: NonNullable<CallState["caption"]>; who: string }) {
  const line = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = line.current;
    if (!el) return;
    el.scrollLeft = el.scrollWidth;
    el.toggleAttribute("data-clipped", el.scrollWidth > el.clientWidth);
  }, [caption.text]);
  return (
    <p data-call-caption className="pointer-events-none col-span-full row-start-1 flex min-w-0 items-center gap-2 self-center px-1 py-1 text-[15px] leading-6">
      <span className="shrink-0 font-medium text-ink">{who}</span>
      <span key={caption.id} ref={line} className="min-w-0 overflow-hidden whitespace-nowrap text-ink-secondary data-clipped:[mask-image:linear-gradient(to_right,transparent,black_1.5rem)]">
        {caption.text.split(/(?<=\s)/).map((word, i) => <span key={i} className="animate-fade-in">{word}</span>)}
      </span>
    </p>
  );
}

function Controls({ bot, live, empty, closing }: { bot: Bot; live: Live; empty: boolean; closing: boolean }) {
  const { locale } = useI18n();
  const words = WORDS[locale] ?? WORDS.en;
  const { call } = live;
  const snap = useSyncExternalStore(call.subscribe, call.state, call.state);
  const [captions, setCaptions] = useState(captionsOn);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!snap.startedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [snap.startedAt]);

  const toggleCaptions = () => {
    setCaptions(!captions);
    try {
      localStorage.setItem(CAPTIONS, captions ? "0" : "1");
    } catch {
      // stays for this call only
    }
  };

  const talking = snap.status === "listening" || snap.status === "speaking" || snap.status === "working";
  const icon = "flex size-8 shrink-0 items-center justify-center rounded-full max-md:size-10";
  return (
    <>
      {captions && empty && snap.caption && <CaptionLine caption={snap.caption} who={snap.caption.who === "user" ? words.you : bot.name} />}
      <div data-call-box={snap.status} data-leaving={closing || undefined} className="col-start-2 row-start-2 mt-1 flex min-w-0 items-center gap-1">
        <p role="status" className="flex min-w-0 items-center gap-2 px-1 text-[13px] tabular-nums text-ink-secondary">
          {snap.status === "starting"
            ? <><Loader2 size={15} className="shrink-0 animate-spin" aria-hidden /><span className="truncate">{words.starting}</span></>
            : talking && <>
              <VoiceBars live={live} muted={snap.muted} />
              {snap.startedAt !== undefined && <span>{clock(now - snap.startedAt)}</span>}
              {snap.status === "working" && <span className="truncate">{words.working}</span>}
            </>}
        </p>
        <span className="ml-auto" />
        {talking && (
          <>
            <button type="button" aria-pressed={captions} aria-label={words.captions} title={words.captions} onClick={toggleCaptions} className={cn(icon, captions ? "bg-accent/15 text-accent" : "text-ink-secondary hover:bg-control hover:text-ink")}>
              <Captions size={17} />
            </button>
            <button type="button" aria-pressed={snap.muted} aria-label={snap.muted ? words.unmute : words.mute} title={snap.muted ? words.unmute : words.mute} onClick={() => call.mute(!snap.muted)} className={cn(icon, snap.muted ? "bg-control text-ink" : "text-ink-secondary hover:bg-control hover:text-ink")}>
              {snap.muted ? <MicOff size={17} /> : <Mic size={17} />}
            </button>
          </>
        )}
        <button type="button" aria-label={words.end} title={words.end} onClick={() => call.end()} className={cn(icon, "bg-danger text-white hover:brightness-110")}>
          <PhoneOff size={16} />
        </button>
      </div>
    </>
  );
}

/** The call's controls in the message box's bottom row, and its caption line where the placeholder sits. */
export function LiveCallBox({ bot, empty, closing }: { bot: Bot; empty: boolean; closing: boolean }) {
  const live = useLive(bot.id);
  const last = useRef(live);
  if (live) last.current = live;
  const shown = live ?? (closing ? last.current : undefined);
  return shown ? <Controls bot={bot} live={shown} empty={empty} closing={closing || !live} /> : null;
}
