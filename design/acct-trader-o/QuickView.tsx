// The chat ticker and its quick view: the same desk, small, one tap away from the chat.
// The card grows out of the ticker line (Alt+U opens it on desktop; a second Alt+U opens all usage).
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";
import { useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { isPhone } from "@/lib/phone-swipe";
import { isTerminalSkin, useSkin } from "@/lib/skins";
import { MIN, type EngineId } from "./fixtures";
import { label, engineName, openQuick, useDesk, useTick } from "./desk-store";
import { AccountList, engineView, Hero, Pct, Tile } from "./Desk";
import { Spark } from "./Chart";
import { useDeskText } from "./strings";

export const ENGINE_OF: Record<string, EngineId> = { claudeAgent: "claude", codex: "codex", grokAgent: "grok", antigravityAgent: "gemini" };

function QuickFooter({ phone }: { phone: boolean }) {
  const { dispatch } = useStore();
  const x = useDeskText();
  return (
    <button type="button" onClick={() => { openQuick(false); dispatch({ type: "toggleAppSettings", open: true, section: "usage" }); }}
      className="flex w-full items-center justify-between gap-3 border-t border-hairline/50 px-4 text-left text-[13px] text-ink transition-colors first:border-t-0 hover:bg-raised-hover/50"
      style={{ height: phone ? 48 : 42 }}>
      <span>{x.t("allUsage")}</span>
      {phone ? <ChevronRight size={16} aria-hidden="true" className="-mr-1 text-ink-secondary" /> : (
        <kbd className="desk-num rounded border border-hairline px-1.5 py-0.5 font-sans text-[10.5px] leading-none text-ink-secondary">Alt U</kbd>
      )}
    </button>
  );
}

export function QuickView({ engine, anchor }: { engine: EngineId; anchor: RefObject<HTMLElement | null> }) {
  const s = useDesk();
  const terminal = isTerminalSkin(useSkin());
  const x = useDeskText();
  const box = useRef<HTMLDivElement>(null);
  const [spot, setSpot] = useState<{ left: number; bottom: number; line: number; width: number } | null>(null);
  const phone = isPhone();
  useLayoutEffect(() => {
    if (!s.quickOpen) return;
    // The card grows out of the line that opened it, so the meter and the composer stay in view.
    // Terminal skins seat it flat on the status line, like a pane over a status bar.
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(380, window.innerWidth - 24);
      const line = window.innerHeight - rect.top;
      setSpot({ left: Math.max(12, Math.min(rect.left - 4, window.innerWidth - width - 12)), bottom: line + (terminal ? 0 : 6), line, width });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [s.quickOpen, anchor, terminal]);
  useEffect(() => {
    if (!s.quickOpen) return;
    const away = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!box.current?.contains(target) && !anchor.current?.contains(target)) openQuick(false);
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") openQuick(false); };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", key);
    };
  }, [s.quickOpen, anchor]);
  if (!s.quickOpen) return null;
  const body = (
    <>
      <Hero engine={engine} size="compact" phone={phone} />
      <div className="mt-3">
        <AccountList engine={engine} size="compact" footer={<QuickFooter phone={phone} />} />
      </div>
    </>
  );
  if (!spot) return null;
  return createPortal(
    <>
      {/* Phone: the chat above dims; the meter line and the composer below stay lit. */}
      {phone && <div aria-hidden="true" className="desk-fade fixed inset-x-0 top-0 z-50 bg-black/45" style={{ bottom: spot.line }} />}
      <div ref={box} role="dialog" aria-label={x.t("usage")} data-desk-quick
        className={cn("desk-sheet fixed z-50 border border-hairline/60 bg-panel p-4 shadow-2xl", terminal ? "rounded-none" : "rounded-2xl")}
        style={{ left: spot.left, bottom: spot.bottom, width: spot.width }}>
        {body}
      </div>
    </>,
    document.body,
  );
}

/** One quiet line above the composer: which account, % left, the live line, the countdown. */
export function ChatTicker({ engine, variant = "chat" }: { engine: EngineId; variant?: "chat" | "term" | "term-phone" }) {
  const s = useDesk();
  const now = useTick(1000);
  const x = useDeskText();
  const anchor = useRef<HTMLButtonElement>(null);
  const view = engineView(s, engine, now);
  const { ticker, inUse, single, note } = view;
  if (ticker.left === null) return null;
  const ends = ticker.verdict.kind === "out" ? ticker.verdict.back : ticker.win!.resetsAt;
  const fresh = note && now - note.at < 10 * MIN && now >= note.at;
  const name = single ? engineName(engine) : label(inUse);
  const fromName = fresh ? view.accounts.find((a) => a.n === note.from) : undefined;
  const say: ReactNode = fresh && fromName
    ? <span key={`n${note.at}`} className="desk-fade truncate text-ink">{x.t("ranOut", { from: label(fromName), to: String(note.to) })}</span>
    : <span key={inUse.id} className="desk-fade truncate text-ink">{name}</span>;
  const aria = x.t("openAria", { name, pct: Math.round(ticker.left) });
  if (variant !== "chat") {
    return (
      <div>
        <button ref={anchor} type="button" data-desk-ticker aria-expanded={s.quickOpen} aria-haspopup="dialog" aria-label={aria} onClick={() => openQuick(!s.quickOpen)}
          className="inline-flex max-w-full items-center gap-[1ch] hover:text-accent-text">
          {!single && <Tile n={inUse.n} className="text-ink" />}
          {variant === "term" && say}
          <Spark win={ticker.win} now={now} verdict={ticker.verdict} live cols={variant === "term" ? 8 : 5} />
          <span className="flex items-baseline gap-[1ch]"><Pct value={ticker.left} tone={ticker.tone} className="font-normal" />{x.t("left")}</span>
          <span className="desk-num text-ink-secondary">↻ {x.countdown(ends - now)}</span>
        </button>
        <QuickView engine={engine} anchor={anchor} />
      </div>
    );
  }
  return (
    <div className="px-5 pb-1.5">
      <button ref={anchor} type="button" data-desk-ticker aria-expanded={s.quickOpen} aria-haspopup="dialog" aria-label={aria} onClick={() => openQuick(!s.quickOpen)}
        className={cn("-mx-2 flex h-7 max-w-full items-center gap-2.5 rounded-md px-2 text-[12px] text-ink-secondary transition-colors hover:bg-control", s.quickOpen && "bg-control")}>
        {!single && <Tile n={inUse.n} />}
        {say}
        <span className="flex shrink-0 items-baseline gap-1"><Pct value={ticker.left} tone={ticker.tone} className="text-[12.5px]" /><span>{x.t("left")}</span></span>
        <Spark win={ticker.win} now={now} verdict={ticker.verdict} width={44} height={14} live cols={5} />
        <span className="desk-num shrink-0">↻ {x.countdown(ends - now)}</span>
      </button>
      <QuickView engine={engine} anchor={anchor} />
    </div>
  );
}
