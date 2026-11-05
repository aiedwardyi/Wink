// The Terminal skin's two-line status under the composer. It takes the place
// of the 5h/7d strip, so the meters still open Usage.
import { useEffect, useId, useRef, useState } from "react";
import { shownModelSelection, useStore, type Bot, type InstanceInfo } from "@/state/store";
import { useI18n } from "@/lib/i18n";
import { shortPath } from "@/lib/short-path";
import { museReading } from "@/lib/usage";
import { chartSeries, leftOf, pace, splitWindows } from "@/lib/usage-pace";
import { termModelLabel } from "@/lib/terminal-skin";
import { useUsageBoard } from "@/lib/use-usage-board";
import { useVisibleClock } from "@/lib/use-visible-clock";
import { PHONE_QUERY } from "@/lib/phone-swipe";
import { useSkin } from "@/lib/skins";
import { lineFacts, meterTarget, meterWindows, useQuickToggle } from "./ChatPlanMeters";
import { brailleFits, UsageSpark } from "./UsageChart";
import { countdown, shortLabel } from "./UsageDesk";
import { UsageQuickView } from "./UsageQuickView";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import "./TermStatusLine.css";

const PHONE_STATUS_QUERY = `${PHONE_QUERY} and (pointer: coarse)`;

export function TermStatusLine({ bot, engine, cwd = bot.cwd, hidden }: { bot: Bot; engine: InstanceInfo | undefined; cwd?: string | null; hidden?: boolean }) {
  const { t } = useI18n();
  const { state } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const skin = useSkin();
  const [phone, setPhone] = useState(() => window.matchMedia?.(PHONE_STATUS_QUERY).matches ?? false);
  useEffect(() => {
    const media = window.matchMedia?.(PHONE_STATUS_QUERY);
    const change = () => setPhone(media?.matches ?? false);
    change();
    media?.addEventListener("change", change);
    return () => media?.removeEventListener("change", change);
  }, []);
  const selection = shownModelSelection(bot);
  const selectedEngine = engine?.instanceId === selection.instanceId ? engine : state.instances.find((instance) => instance.instanceId === selection.instanceId);
  const model = selectedEngine?.models.options.find((option) => option.id === selection.model)?.label ?? selection.model;
  const ticker = <TermTicker hidden={hidden} identity={`${bot.id}:${bot.threadId}:${selectedEngine?.accountOf ?? selection.instanceId}`} instance={selectedEngine}
    instanceId={selection.instanceId} tightest={phone && skin === "multiplexer"} phone={phone} />;
  const phoneModel = termModelLabel(model);
  if (phone) return (
    <div data-term-status data-term-window={bot.name} data-term-phone={skin} role="group" aria-label={t("term.status.aria")} className="term-status">
      {skin === "multiplexer" && (
        <span data-term-tab title={bot.name}>
          <span>0:</span><span data-term-tab-name>{bot.name}</span><span>*</span>
        </span>
      )}
      <div data-term-model>
        {skin !== "multiplexer" && <><span aria-hidden="true" className="text-accent">◆</span>{" "}</>}
        {phoneModel}
      </div>
      {ticker}
    </div>
  );
  return (
    <div data-term-status data-term-window={bot.name} role="group" aria-label={t("term.status.aria")} className="term-status">
      <div>
        <span aria-hidden="true" className="text-accent">◆</span> {model}
        {cwd && (
          <>
            <span aria-hidden="true" className="text-ink-secondary"> │ </span>
            {shortPath(cwd, capabilities.host.homeDir)}
          </>
        )}
        {selection.effort && <span className="text-ink-secondary"> · {selection.effort}</span>}
      </div>
      {ticker}
    </div>
  );
}

const HOUR = 3_600_000;
/** Hidden for the bars-first look (no graphs anywhere): the glyph trace stays in code, not rendered. */
const SHOW_SPARK = false;

/** The quota half of the status line: tile, % left and the reset countdown; the words live in its description. */
function TermTicker({ hidden, identity, instance, instanceId, tightest, phone }: { hidden?: boolean; identity: string; instance: InstanceInfo | undefined; instanceId: string; tightest: boolean; phone: boolean }) {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const board = useUsageBoard();
  const target = meterTarget(board.board, state.instances, instanceId);
  const minute = useVisibleClock();
  const windows = meterWindows(target, instance?.rateLimits?.windows, minute);
  const facts = lineFacts(windows, target?.account.coverage ?? "unknown", t);
  const binding = facts.binding;
  const soon = binding?.resetsAt != null && binding.resetsAt > minute && binding.resetsAt - minute < HOUR;
  const now = useVisibleClock(soon);
  // Only a ticker that renders may take Alt+U; a hidden one leaves the key to all Usage.
  const quick = Boolean(!hidden && binding && target && board.board);
  const [open, setOpen] = useQuickToggle(quick, identity);
  const button = useRef<HTMLButtonElement>(null);
  const ageId = useId();
  const summaryId = useId();
  if (!binding) return null;
  // A window with no data stays off the line (it never shows a 5h it lacks); "Weekly only" and real windows stay.
  const { session, week } = splitWindows(windows);
  const second = !session && week && (target?.account.coverage ?? "unknown") !== "complete" ? null : facts.second;
  const account = target?.account;
  const reading = museReading(instance?.driverKind, account ? account.observedAt === null ? undefined : new Date(account.observedAt).toISOString() : instance?.rateLimits?.observedAt, now);
  const verdict = target ? pace(target.account, binding, target.engine.events, now).verdict : undefined;
  const tone = reading?.stale ? "ok" : binding.usedPercent >= 100 ? "out" : verdict?.kind === "runsOut" ? "warn" : "ok";
  const series = target ? chartSeries(target.account, binding, target.engine.events, now) : null;
  const left = Math.round(leftOf(binding));
  const reset = binding.resetsAt !== null && binding.resetsAt > now ? countdown(binding.resetsAt - now, t) : null;
  const summary = [reset ? t("usage.chat.termSummary", { window: shortLabel(binding, t), percent: left, time: reset }) : `${facts.first}. ${t("usage.limits.resetUnknown")}`,
    !tightest && second].filter(Boolean).join(". ");
  const multi = target && target.engine.accounts.length > 1;
  const name = multi ? target.account.name : undefined;
  const activate = () => { if (quick) setOpen(!open); else dispatch({ type: "toggleAppSettings", open: true, section: "usage" }); };
  return (
    <div data-term-meters={tightest || !second ? 1 : 2}>
      <button ref={button} type="button" data-term-ticker="" onClick={activate}
        aria-haspopup={quick ? "dialog" : undefined} aria-expanded={quick ? open : undefined}
        aria-label={name ? t("usage.chat.openAria", { name }) : t("usage.limits.openAria")}
        aria-describedby={[summaryId, reading ? ageId : ""].filter(Boolean).join(" ")}
        className={reading?.stale ? "text-ink-secondary hover:text-accent-text" : "hover:text-accent-text"}>
        {reading && !phone && <><span id={ageId} className="text-ink-secondary">{reading.label(t)}</span><span aria-hidden="true" className="text-ink-secondary"> · </span></>}
        {reading && phone && <span id={ageId} className="sr-only">{reading.label(t)}</span>}
        {multi && <span aria-hidden="true" className="text-ink-secondary">[{target.account.number}] </span>}
        {SHOW_SPARK && <span data-glyphs={brailleFits() ? "braille" : "block"} className="inline-flex align-baseline">
          <UsageSpark series={series} tone={tone} terminal />
        </span>}
        <span aria-hidden="true" className={tone === "out" ? "text-danger" : tone === "warn" ? "text-warning" : undefined}>{SHOW_SPARK && " "}{facts.first}</span>
        {reset && <span aria-hidden="true" className="text-ink-secondary"> ↻ {reset}</span>}
        {!tightest && second && <span aria-hidden="true" className="text-ink-secondary"> │ {second}</span>}
        <span id={summaryId} className="sr-only">{summary}</span>
      </button>
      {open && target && board.board && (
        <UsageQuickView engine={target.engine} account={target.account} board={board.board} state={board} anchor={button} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}
