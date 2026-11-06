import { useEffect, useRef, useState } from "react";
import type { RateLimitWindow } from "../../server/contracts.ts";
import { useI18n, type Translate } from "@/lib/i18n";
import { usageAccount } from "@/lib/accounts";
import { planMeterWindows, windowExpired, windowKind } from "@/lib/usage";
import type { UsageBoard, UsageBoardAccount, UsageBoardEngine, UsageBoardWindow } from "@/lib/usage-board";
import { useUsageBoard } from "@/lib/use-usage-board";
import { useVisibleClock } from "@/lib/use-visible-clock";
import { useStore, type InstanceInfo } from "@/state/store";
import { engineName, windowFacts } from "./UsageDesk";
import { UsageQuickView } from "./UsageQuickView";
import { barSlots, WindowBar } from "./UsageBars";
import "./UsageDesk.css";

type ChatPlanMetersProps = {
  windows: RateLimitWindow[] | undefined;
  driverKind?: string;
  observedAt?: string;
  /** The chat's shown engine instance; without it the line shows today's values and opens Usage directly. */
  instanceId?: string;
  /** Bot, task and engine; a change shuts an open quick view before the next identity paints. */
  identity?: string;
  /** The chat is covered (the terminal is open): no quick view, and Alt+U falls through to all Usage. */
  hidden?: boolean;
  now?: number;
  onOpenUsage: () => void;
};

export type MeterTarget = { engine: UsageBoardEngine; account: UsageBoardAccount };

/** The board row a chat's quota belongs to: its engine's Main, or where a draining Main is moving. Joined by id only. */
export function meterTarget(board: UsageBoard | null, instances: InstanceInfo[], instanceId: string | undefined): MeterTarget | null {
  if (!board || !instanceId) return null;
  const shown = usageAccount(instances, instanceId) ?? instances.find((instance) => instance.instanceId === instanceId);
  const base = shown?.accountOf ?? shown?.instanceId ?? instanceId;
  const engine = board.engines.find((each) => each.base === base || each.accounts.some((account) => account.id === base));
  if (!engine) return null;
  const draining = instances.find((instance) => instance.instanceId === engine.mainId)?.drain;
  const id = draining && draining.phase !== "failed" ? usageAccount(instances, engine.mainId)?.instanceId ?? engine.mainId : engine.mainId;
  const account = engine.accounts.find((each) => each.id === id);
  return account ? { engine, account } : null;
}

const liveWindows = (windows: UsageBoardWindow[], now: number) => windows.filter((window) => !windowExpired(window.resetsAt, now));

/** The windows a usage line shows: the board row's live ones, else today's instance report. */
export function meterWindows(target: MeterTarget | null, windows: RateLimitWindow[] | undefined, now: number) {
  return target ? liveWindows(target.account.windows, now) : todayWindows(windows, now);
}

function todayWindows(windows: RateLimitWindow[] | undefined, now: number): UsageBoardWindow[] {
  // An unread value has no percent to show; the line never makes one up.
  return planMeterWindows(windows, now).filter((window) => Number.isFinite(window.usedPercent)).map((window) => {
    const kind = windowKind(window.id, window.windowMinutes);
    return { id: window.id, kind: kind === "session" ? "session" : kind === "weekly" ? "week" : "other",
      usedPercent: window.usedPercent, resetsAt: window.resetsAt ?? null, windowMinutes: window.windowMinutes ?? null };
  });
}

export function lineFacts(windows: UsageBoardWindow[], coverage: UsageBoardAccount["coverage"], t: Translate) {
  return windowFacts({ windows, coverage } as Pick<UsageBoardAccount, "windows" | "coverage"> as UsageBoardAccount, t);
}

/**
 * Open state for a line's quick view; Alt+U reaches it through App's `orbit:usage-key` event, never a module listener.
 * The view is open for one identity: a new bot, task or engine reads as shut on its first render, while the line itself stays
 * mounted so its board subscription (and the cache behind it) carries over without a read.
 */
export function useQuickToggle(quick: boolean, identity: string) {
  const [openFor, setOpenFor] = useState<string | null>(null);
  if (openFor !== null && (openFor !== identity || !quick)) setOpenFor(null);
  const open = openFor === identity;
  const setOpen = (next: boolean) => setOpenFor(next ? identity : null);
  useEffect(() => {
    if (!quick) return;
    const key = (event: Event) => {
      if (event.defaultPrevented) return;
      if (open) { setOpen(false); return; }
      event.preventDefault();
      setOpen(true);
    };
    window.addEventListener("orbit:usage-key", key);
    return () => window.removeEventListener("orbit:usage-key", key);
  }, [quick, open, identity]); // eslint-disable-line react-hooks/exhaustive-deps
  return [open && quick, setOpen] as const;
}

export function ChatPlanMeters(props: ChatPlanMetersProps) {
  return props.instanceId ? <BoardMeter {...props} instanceId={props.instanceId} /> : <TodayMeter {...props} />;
}

function TodayMeter({ windows, now, onOpenUsage }: ChatPlanMetersProps) {
  // Decide visibility without the clock; chats without windows never subscribe to a tick.
  if (todayWindows(windows, now ?? Date.now()).length === 0) return null;
  return <MeterLine windows={windows} now={now} onOpen={onOpenUsage} />;
}

function BoardMeter({ windows, instanceId, identity = instanceId, hidden, now, onOpenUsage }: ChatPlanMetersProps & { instanceId: string }) {
  const { state } = useStore();
  const board = useUsageBoard();
  const target = meterTarget(board.board, state.instances, instanceId);
  const at = now ?? Date.now();
  if (meterWindows(target, windows, at).length === 0 && target?.account.signIn !== "signed-out") return null;
  return <MeterLine windows={windows} now={now} onOpen={onOpenUsage} identity={identity} hidden={hidden} target={target} board={board} />;
}

function MeterLine({ windows, now, onOpen, identity = "", hidden, target, board }: {
  windows: RateLimitWindow[] | undefined; now?: number; onOpen: () => void; identity?: string; hidden?: boolean;
  target?: MeterTarget | null; board?: ReturnType<typeof useUsageBoard>;
}) {
  const { t } = useI18n();
  const tick = useVisibleClock();
  const clock = now ?? tick;
  const button = useRef<HTMLButtonElement>(null);
  const signedOut = target?.account.signIn === "signed-out";
  const shown = meterWindows(target ?? null, windows, clock);
  const quick = Boolean(!hidden && target && board?.board && (shown.length > 0 || signedOut));
  const [open, setOpen] = useQuickToggle(quick, identity);
  if (shown.length === 0 && !signedOut) return null;
  return (
    <div className="px-5 pb-1">
      <button ref={button} type="button" data-usage-meter="" onClick={onOpen}
        aria-label={t("usage.limits.openAria")} className="usage-chat-button w-full cursor-pointer text-left">
        {signedOut && target ? <span className="flex min-w-0 items-center gap-2 px-4 text-[12px]">
          <span data-meter-name="" className="min-w-0 truncate text-ink-secondary">{target.engine.accounts.length > 1 ? target.account.name : engineName(target.engine.engine)}</span>
          <span data-meter-signed-out="" className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-warning">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-warning" />{t("usage.chat.signedOut")}
          </span>
        </span> : <span className="usage-chat-windows" data-windows={shown.length}>
          {barSlots(target?.engine.engine ?? "", { windows: shown }, t).map((slot) => <WindowBar key={`${target?.account.id ?? "today"}:${slot.key}`} slot={slot} now={clock} t={t} chat />)}
        </span>}
      </button>
      {open && target && board?.board && (
        <UsageQuickView engine={target.engine} account={target.account} board={board.board} state={board} anchor={button} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}
