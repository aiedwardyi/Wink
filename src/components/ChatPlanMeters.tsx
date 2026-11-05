// One compact usage line above the composer: whose quota, the window that runs out first, then the other.
// A tap or Alt+U grows the quick view out of it. Hidden when the engine has no live windows.
import { useEffect, useId, useRef, useState } from "react";
import type { RateLimitWindow } from "../../server/contracts.ts";
import { useI18n, type Translate } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { usageAccount } from "@/lib/accounts";
import { museReading, planMeterWindows, windowExpired, windowKind } from "@/lib/usage";
import type { UsageBoard, UsageBoardAccount, UsageBoardEngine, UsageBoardWindow } from "@/lib/usage-board";
import { pace } from "@/lib/usage-pace";
import { useUsageBoard } from "@/lib/use-usage-board";
import { useVisibleClock } from "@/lib/use-visible-clock";
import { useStore, type InstanceInfo } from "@/state/store";
import { engineName, windowFacts } from "./UsageDesk";
import { UsageQuickView } from "./UsageQuickView";

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

function TodayMeter({ windows, driverKind, observedAt, now, onOpenUsage }: ChatPlanMetersProps) {
  // Decide visibility without the clock; chats without windows never subscribe to a tick.
  if (todayWindows(windows, now ?? Date.now()).length === 0) return null;
  return <MeterLine windows={windows} driverKind={driverKind} observedAt={observedAt} now={now} onOpen={onOpenUsage} />;
}

function BoardMeter({ windows, driverKind, observedAt, instanceId, identity = instanceId, hidden, now, onOpenUsage }: ChatPlanMetersProps & { instanceId: string }) {
  const { state } = useStore();
  const board = useUsageBoard();
  const target = meterTarget(board.board, state.instances, instanceId);
  const at = now ?? Date.now();
  if (meterWindows(target, windows, at).length === 0) return null;
  const own = state.instances.find((instance) => instance.instanceId === instanceId);
  const base = state.instances.find((instance) => instance.instanceId === (own?.accountOf ?? instanceId));
  return <MeterLine windows={windows} driverKind={driverKind} observedAt={observedAt} now={now} onOpen={onOpenUsage} identity={identity} hidden={hidden}
    target={target} board={board} engineLabel={base?.displayName} />;
}

function MeterLine({ windows, driverKind, observedAt, now, onOpen, identity = "", hidden, target, board, engineLabel }: {
  windows: RateLimitWindow[] | undefined; driverKind?: string; observedAt?: string; now?: number; onOpen: () => void; identity?: string; hidden?: boolean;
  target?: MeterTarget | null; board?: ReturnType<typeof useUsageBoard>; engineLabel?: string;
}) {
  const { t } = useI18n();
  const tick = useVisibleClock();
  const clock = now ?? tick;
  const button = useRef<HTMLButtonElement>(null);
  const ageId = useId();
  const account = target?.account;
  const shown = meterWindows(target ?? null, windows, clock);
  const facts = lineFacts(shown, account?.coverage ?? "unknown", t);
  const reading = museReading(driverKind, account ? account.observedAt === null ? undefined : new Date(account.observedAt).toISOString() : observedAt, clock);
  const runsOut = target && facts.binding ? pace(target.account, facts.binding, target.engine.events, clock).verdict.kind === "runsOut" : false;
  const name = target && target.engine.accounts.length > 1 ? target.account.name : target ? engineName(target.engine.engine) : engineLabel;
  const quick = Boolean(!hidden && target && board?.board && shown.length > 0);
  const [open, setOpen] = useQuickToggle(quick, identity);
  const toggle = () => { if (quick) setOpen(!open); else onOpen(); };
  if (shown.length === 0) return null;
  return (
    <div className="px-5 pb-1">
      <button
        ref={button}
        type="button"
        data-usage-meter=""
        onClick={toggle}
        aria-haspopup={quick ? "dialog" : undefined}
        aria-expanded={quick ? open : undefined}
        aria-label={name ? t("usage.chat.openAria", { name }) : t("usage.limits.openAria")}
        aria-describedby={reading?.stale ? ageId : undefined}
        className={cn("-mx-2 flex min-h-7 max-w-full items-baseline gap-2 rounded-[3px] [corner-shape:bevel] px-2 py-1 text-left text-ink-secondary transition-colors duration-100 hover:bg-raised-hover motion-reduce:transition-none [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:items-center",
          open && "bg-raised-hover", reading?.stale && "opacity-70")}
      >
        {name && <span data-meter-name="" className="min-w-0 truncate text-[12px]">{name}</span>}
        <span data-meter-first="" className={cn("usage-num shrink-0 whitespace-nowrap text-[12px]",
          reading?.stale ? "text-ink-secondary" : facts.binding && facts.binding.usedPercent >= 100 ? "text-danger" : runsOut ? "text-warning" : "text-ink")}>{facts.first}</span>
        {facts.second && <span data-meter-second="" className="usage-num shrink-0 whitespace-nowrap text-[12px]">{facts.second}</span>}
        {reading?.stale && <span id={ageId} className="min-w-0 truncate text-[12px]">{reading.label(t)}</span>}
      </button>
      {open && target && board?.board && (
        <UsageQuickView engine={target.engine} account={target.account} board={board.board} state={board} anchor={button} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}
