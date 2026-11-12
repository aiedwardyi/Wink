import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Bot, Check, ChevronDown, ScrollText, TerminalSquare, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { chipEffortLabel, chipEffortShortLabel } from "@/lib/model-chip";
import { NOTE_STATUS_KEY, noteText } from "@/lib/pane-note";
import { isPhone, PHONE_QUERY } from "@/lib/phone-swipe";
import { useBackLayer } from "@/lib/use-back-layer";
import { useSheetSwipe } from "@/lib/use-phone-swipe";
import type { Message } from "@/state/store";
import { listedRuns, listedSessionId, workerAnchors, type WorkerRun, type WorkerShownState } from "@/lib/worker-runs";
import { ProviderMark } from "./ProviderIcons";
import { Fold } from "./Fold";
import { trackScreen } from "@/lib/usage-stats";

export const WORKER_STATUS = {
  working: { key: "workers.working", text: "text-accent", dot: "bg-accent" },
  waiting: { key: "workers.waiting", text: "text-warning", dot: "bg-warning" },
  failed: { key: "workers.failed", text: "text-danger", dot: "bg-danger" },
  done: { key: "workers.done", text: "text-success", dot: "bg-success" },
  ended: { key: "workers.ended", text: "text-ink-secondary", dot: "bg-ink-secondary" },
} as const satisfies Record<WorkerShownState, { key: string; text: string; dot: string }>;

export type ShownRun = { run: WorkerRun; state: WorkerShownState };

export function useWorkerRows(workers: ShownRun[], messages: Message[]) {
  const workerAt = useMemo(() => workerAnchors(workers, messages), [messages, workers]);
  const [open, setOpen] = useState(new Set<string>());
  const toggle = useCallback((id: string) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }), []);
  return { workerAt, open, toggle };
}

export function WorkerMark({ provider, compact = false }: { provider: string | null; compact?: boolean }) {
  // brand marks stay untinted; only the script and unknown-model glyphs take the ink color
  const size = 14;
  return (
    <span aria-hidden={compact || undefined} className={compact ? "mr-1.5 inline-flex size-3.5 shrink-0 items-center justify-center align-middle" : "flex size-6 shrink-0 items-center justify-center rounded-md border border-hairline/40 bg-raised"}>
      {provider === "script" ? <ScrollText size={size} className="text-ink-secondary" aria-hidden /> : provider ? <ProviderMark driverKind={provider} size={size} /> : <Bot size={size} className="text-ink-secondary" aria-hidden />}
    </span>
  );
}

// Drawn, not typed: text glyph shapes render differently per OS.
function WorkerStatusMark({ state }: { state: WorkerShownState }) {
  return (
    <span aria-hidden data-worker-mark className="flex size-3 shrink-0 items-center justify-center">
      {state === "working" ? <span className={cn("size-2 rounded-full", WORKER_STATUS.working.dot)} />
        : state === "ended" ? <span className="size-2 rounded-full border border-current" />
        : state === "waiting" ? <span className="flex gap-0.5"><span className="h-2.5 w-0.5 bg-current" /><span className="h-2.5 w-0.5 bg-current" /></span>
        : state === "failed" ? <AlertTriangle size={12} />
        : <Check size={12} />}
    </span>
  );
}

function WorkerStatus({ state }: { state: WorkerShownState }) {
  const { t } = useI18n();
  const status = WORKER_STATUS[state];
  return (
    <span data-worker-state={state} className={cn("flex shrink-0 items-center gap-1 text-[12.5px]", status.text)}>
      <WorkerStatusMark state={state} />
      {t(status.key)}
    </span>
  );
}

function WorkerLine({ run, state, nickFirst = false }: ShownRun & { nickFirst?: boolean }) {
  const { t } = useI18n();
  const effort = run.model && run.effort ? chipEffortLabel(run.effort, t) : "";
  const short = run.model && run.effort ? chipEffortShortLabel(run.effort, t) : "";
  return (
    <>
      <WorkerMark provider={run.provider} />
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="truncate font-medium text-ink">{run.nick}</span>
        {run.model && (nickFirst ? (
          // Basis zero shrinks the model first and the cap, margin and pre keep the spaced dot beside it.
          <>
            <span className="min-w-0 max-w-max flex-1 -mr-2 truncate whitespace-nowrap text-ink-secondary">{run.model}</span>
            {effort && <span className="shrink-0 whitespace-pre text-ink-secondary">{" · "}{short}</span>}
          </>
        ) : (
          <span className="shrink-0 whitespace-nowrap text-ink-secondary">
            {run.model}
            {effort && <> · {short === effort ? effort : (<><span className="max-md:hidden">{effort}</span><span className="md:hidden">{short}</span></>)}</>}
          </span>
        ))}
      </span>
      <WorkerStatus state={state} />
    </>
  );
}

/** A worker run's one transcript row; its notes fold in and open on tap. */
export function WorkerRow({ run, state, live, onOpenTerminalPane, open: expanded, onToggle }: ShownRun & { live: boolean | null; onOpenTerminalPane?: (sessionId: string) => void; open?: boolean; onToggle?: () => void }) {
  const { t } = useI18n();
  const [localOpen, setLocalOpen] = useState(false);
  const open = expanded ?? localOpen;
  const jump = live && run.sessionId && onOpenTerminalPane ? run.sessionId : null;
  const finished = state === "done" || state === "failed" || state === "ended";
  const where = finished ? "chat.launchRanIn" : live ? "chat.launchRunningIn" : "chat.launchFolder";
  return (
    <div data-worker-run={run.id} className="flex w-full flex-col">
      <button
        type="button"
        onClick={onToggle ?? (() => setLocalOpen((v) => !v))}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 border-b border-hairline/40 py-2 text-left text-[13px] hover:bg-raised/40"
      >
        <WorkerLine run={run} state={state} />
        <ChevronDown size={12} aria-hidden className={cn("shrink-0 text-ink-secondary transition-transform", open && "rotate-180")} />
      </button>
      <Fold open={open}>
        {/* pane text is untrusted; plain text only, never markdown */}
        <div data-orbit-worker className="flex flex-col gap-2 border-b border-hairline/40 py-2 pl-8.5 text-[12.5px] leading-relaxed text-ink-secondary">
          {run.folder && (jump ? (
            <button type="button" onClick={() => onOpenTerminalPane?.(jump)} className="self-start text-left underline-offset-2 hover:text-ink hover:underline">
              {t(where, { folder: run.folder })}
            </button>
          ) : (
            <div>{t(where, { folder: run.folder })}</div>
          ))}
          {run.notes.map(({ id, note }) => (
            <div key={id} className="whitespace-pre-wrap break-words">
              {note.status && <div className="font-medium text-ink">{t(NOTE_STATUS_KEY[note.status])}</div>}
              {noteText(note, t)}
            </div>
          ))}
        </div>
      </Fold>
    </div>
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const ENTRY_CLASS = "flex w-full items-center gap-2.5 border-b border-hairline/40 py-2.5 text-left text-[13px] last:border-b-0";

function WorkerEntries({ runs, livePanes, onOpenTerminalPane, onClose, inset, nickFirst = false, hotkeyOf }: { runs: ShownRun[]; livePanes: Set<string> | null; onOpenTerminalPane?: (sessionId: string) => void; onClose: () => void; inset?: boolean; nickFirst?: boolean; hotkeyOf?: (sessionId: string | null) => number | undefined }) {
  const entry = cn(ENTRY_CLASS, inset && "px-3");
  return (
    // The sheet's list spans its padding, so a phone's overlay scrollbar paints there instead of over the status.
    <ul
      className={cn("min-h-0 overflow-y-auto", !inset && "-mx-5 px-5 overscroll-y-contain touch-pan-down touch-pinch-zoom")}
      onScroll={!inset ? (event) => {
        // Set this before the next touch starts; changing it during a gesture is too late.
        // pan-down names the scroll, not the finger: it lets a finger move up only.
        event.currentTarget.style.touchAction = event.currentTarget.scrollTop > 0 ? "pan-y pinch-zoom" : "pan-down pinch-zoom";
      } : undefined}
    >
      {runs.map((shown) => {
        const sessionId = listedSessionId(shown.run, livePanes);
        if (!onOpenTerminalPane || !sessionId) {
          return (
            <li key={shown.run.id}>
              <div className={entry}>
                <WorkerLine {...shown} nickFirst={nickFirst} />
              </div>
            </li>
          );
        }
        const hotkey = hotkeyOf?.(sessionId);
        return (
          <li key={shown.run.id}>
            <button
              type="button"
              title={hotkey ? `${shown.run.nick} (Alt+${hotkey})` : undefined}
              onClick={() => {
                onOpenTerminalPane(sessionId);
                onClose();
              }}
              className={cn(entry, "hover:bg-raised/40")}
            >
              <WorkerLine {...shown} nickFirst={nickFirst} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function TerminalEntry({ onOpenTerminal, onClose, inset, hotkey }: { onOpenTerminal: () => void; onClose: () => void; inset?: boolean; hotkey?: number }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      data-worker-terminal=""
      title={hotkey ? `${t("terminal.open")} (Alt+${hotkey})` : undefined}
      onClick={() => {
        onOpenTerminal();
        onClose();
      }}
      className={cn(ENTRY_CLASS, "shrink-0 border-t hover:bg-raised/40", inset && "px-3")}
    >
      <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-hairline/40 bg-raised">
        <TerminalSquare size={18} aria-hidden className="text-ink-secondary" />
      </span>
      <span className="min-w-0 flex-1 truncate font-medium text-ink">{t("terminal.open")}</span>
      {inset && <kbd className="shrink-0 font-sans text-[12.5px] text-ink-secondary">{window.ogb?.platform === "darwin" ? "⌘" : "Ctrl+"}`</kbd>}
    </button>
  );
}

function WorkerList({ title, runs, livePanes, onClose, onOpenTerminalPane, onOpenTerminal }: { title: string; runs: ShownRun[]; livePanes: Set<string> | null; onClose: () => void; onOpenTerminalPane?: (sessionId: string) => void; onOpenTerminal?: () => void }) {
  const { t } = useI18n();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useSheetSwipe(panelRef, true, onClose);
  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (!panel.contains(active)) {
        event.preventDefault();
        event.stopPropagation();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        event.stopPropagation();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        event.stopPropagation();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus();
    };
  }, []);
  return createPortal(
    <div
      className="animate-fade-in fixed inset-0 z-50 flex items-end justify-center bg-black/55 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal
        aria-labelledby={titleId}
        data-worker-list
        className="animate-pop-in flex max-h-[80dvh] w-full touch-[pan-up_pinch-zoom] flex-col rounded-t-[24px] border border-hairline/50 bg-panel px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4 shadow-2xl shadow-black/50"
      >
        <div aria-hidden className="mx-auto -mt-2 mb-1 h-1 w-9 shrink-0 rounded-full bg-ink-secondary/40" />
        <div className="mb-1 flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-[15px] font-semibold text-ink">{title}</h2>
          <button ref={closeRef} type="button" onClick={onClose} aria-label={t("workers.close")} className="flex size-11 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink">
            <X size={16} />
          </button>
        </div>
        <WorkerEntries nickFirst runs={runs} livePanes={livePanes} onOpenTerminalPane={onOpenTerminalPane} onClose={onClose} />
        {onOpenTerminal && <TerminalEntry onOpenTerminal={onOpenTerminal} onClose={onClose} />}
      </div>
    </div>,
    document.body,
  );
}

/** Header chip for this chat's listed runs. Opens the worker list. */
export function WorkerChip({ name, runs, livePanes = null, paneLabels, endedPanes, waitForLive = false, onOpenTerminalPane, onOpenTerminal, hotkeyOf, className }: { name: string; runs: ShownRun[]; livePanes?: Set<string> | null; paneLabels?: ReadonlyMap<string, string>; endedPanes?: ReadonlySet<string>; waitForLive?: boolean; onOpenTerminalPane?: (sessionId: string) => void; onOpenTerminal?: () => void; hotkeyOf?: (sessionId: string | null) => number | undefined; className?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  useEffect(() => { if (open) trackScreen("workers"); }, [open]);
  const [right, setRight] = useState(0);
  const [width, setWidth] = useState(440);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const listed = livePanes === null && waitForLive ? [] : listedRuns(runs, livePanes, paneLabels, endedPanes);
  const shown = listed.length > 0 || Boolean(onOpenTerminal);
  const [phone, setPhone] = useState(isPhone);
  useEffect(() => {
    const media = window.matchMedia?.(PHONE_QUERY);
    const flip = () => {
      setPhone(isPhone());
      setOpen(false);
    };
    media?.addEventListener?.("change", flip);
    return () => media?.removeEventListener?.("change", flip);
  }, []);
  useEffect(() => {
    if (!shown) setOpen(false);
  }, [shown]);
  useBackLayer(open && phone, () => setOpen(false));
  useLayoutEffect(() => {
    if (!open || phone || !rootRef.current) return;
    const root = rootRef.current;
    const main = root.closest("main");
    const place = () => {
      // The menu hangs left of the chip; the chat column clips its edges.
      const row = root.getBoundingClientRect();
      const bounds = main?.getBoundingClientRect();
      const [min, max] = bounds ? [bounds.left + 8, bounds.right - 8] : [8, window.innerWidth - 8];
      const menuWidth = Math.min(440, max - min);
      setWidth(menuWidth);
      setRight(row.right - Math.min(Math.max(row.right, min + menuWidth), max));
    };
    place();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(root);
    if (main) observer?.observe(main);
    window.addEventListener("resize", place);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [open, phone]);
  useEffect(() => {
    if (!open || phone) return;
    let byEscape = false;
    const onDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector("[data-media-viewer]")) return;
      event.preventDefault();
      event.stopPropagation();
      byEscape = true;
      setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
      if (byEscape) buttonRef.current?.focus();
    };
  }, [open, phone]);
  useEffect(() => {
    if (!shown) return;
    const onToggle = () => {
      // Chat stays mounted under the terminal, so only the chip that is not inert answers Alt+W.
      if (rootRef.current?.closest("[inert]")) return;
      if (open && rootRef.current?.contains(document.activeElement)) buttonRef.current?.focus();
      setOpen(!open);
    };
    window.addEventListener("orbit:toggle-worker-menu", onToggle);
    return () => window.removeEventListener("orbit:toggle-worker-menu", onToggle);
  }, [shown, open]);
  useEffect(() => {
    if (!open) return;
    const onClose = () => setOpen(false);
    window.addEventListener("orbit:close-worker-menu", onClose);
    return () => window.removeEventListener("orbit:close-worker-menu", onClose);
  }, [open]);
  if (!shown) return null;
  const first = listed[0];
  const counts = {
    working: listed.filter((shown) => shown.state === "working").length,
    waiting: listed.filter((shown) => shown.state === "waiting").length,
    failed: listed.filter((shown) => shown.state === "failed").length,
    done: listed.filter((shown) => shown.state === "done").length,
  };
  const close = () => setOpen(false);
  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        data-worker-strip=""
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={t("workers.stripAria", counts)}
        title={t("workers.tooltip")}
        className={cn("relative flex shrink-0 items-center whitespace-nowrap", className)}
      >
        <span data-worker-chip-desktop className={cn("hidden items-center gap-1.5 rounded-md px-1.5 py-1 md:flex @max-4xl/chathead:!hidden", !className && "hover:bg-raised")}>
          <Bot size={15} aria-hidden className="shrink-0 text-ink-secondary" />
          {first && <span aria-hidden className="text-[13px] text-ink-secondary">{t(listed.length === 1 ? "workers.countOne" : "workers.countMany", { count: listed.length })}</span>}
          {first && <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", WORKER_STATUS[first.state].dot)} />}
        </span>
        {/* md: sizes apply when a narrow chat header unhides this compact form on desktop. */}
        <span data-worker-chip-phone className="relative flex items-center gap-1 md:hidden md:p-1.5 @max-4xl/chathead:!flex">
          <Bot size={15} aria-hidden className="shrink-0 text-ink-secondary md:size-[18px]" />
          {listed.length >= 2 && <span aria-hidden className="text-[12px] tabular-nums text-ink-secondary">{listed.length}</span>}
          {first && <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", WORKER_STATUS[first.state].dot)} />}
          <span aria-hidden className="absolute left-1/2 top-1/2 size-11 -translate-x-1/2 -translate-y-1/2" />
        </span>
      </button>
      {open && phone && <WorkerList title={t("workers.title", { name })} runs={listed} livePanes={livePanes} onClose={close} onOpenTerminalPane={onOpenTerminalPane} onOpenTerminal={onOpenTerminal} />}
      {open && !phone && (
        <div
          data-worker-list
          role="dialog"
          aria-labelledby={titleId}
          style={{ right, width }}
          className="absolute top-full z-40 mt-1 overflow-hidden rounded-xl border border-hairline/50 bg-card py-1 shadow-2xl shadow-black/50"
        >
          <h2 id={titleId} className="px-3 py-2 text-[15px] font-semibold text-ink">{t("workers.title", { name })}</h2>
          <div className="max-h-[320px] overflow-y-auto">
            <WorkerEntries inset nickFirst runs={listed} livePanes={livePanes} onOpenTerminalPane={onOpenTerminalPane} onClose={close} hotkeyOf={hotkeyOf} />
          </div>
          {onOpenTerminal && <TerminalEntry inset onOpenTerminal={onOpenTerminal} onClose={close} hotkey={hotkeyOf?.(null)} />}
        </div>
      )}
    </div>
  );
}
