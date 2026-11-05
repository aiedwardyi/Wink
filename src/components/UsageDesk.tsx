import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { localeTag, useI18n, type Translate } from "@/lib/i18n";
import { EASE_ENTRANCE, MOTION_FAST_MS } from "@/lib/motion";
import { reducedMotion } from "@/lib/phone-swipe";
import { isTerminalSkin, useSkin } from "@/lib/skins";
import { museReading, resetCompact, windowExpired } from "@/lib/usage";
import type { UsageBoard, UsageBoardAccount, UsageBoardEngine, UsageBoardEvent, UsageBoardWindow } from "@/lib/usage-board";
import { checkedMain, requestMain, type UsageBoardState } from "@/lib/usage-board-client";
import { bindingWindow, chartSeries, historyColumn, leftOf, pace, splitWindows, todayVsNormal, type Verdict } from "@/lib/usage-pace";
import { useIsPhone } from "@/lib/use-phone-swipe";
import { useUsageBoard } from "@/lib/use-usage-board";
import { useVisibleClock } from "@/lib/use-visible-clock";
import { useStore } from "@/state/store";
import { Fold } from "./Fold";
import { ProviderMark } from "./ProviderIcons";
import { EmptyState } from "./SettingsPrimitives";
import { AccountPicker } from "./UsageAccounts";
import { AccountBars } from "./UsageBars";
import { PagedAccounts, type RowSlots } from "./UsagePaged";
import { USAGE_LAYOUT } from "./usage-layout";
import { UsageChart, UsageSpark, type ChartTone } from "./UsageChart";
import "./UsageDesk.css";

const MIN = 60_000;
const HOUR = 60 * MIN;
const ENGINE_NAME: Record<string, string> = { claude: "Claude", codex: "Codex", grok: "Grok", gemini: "Gemini", muse: "Muse" };
export const ENGINE_DRIVER: Record<string, string> = { claude: "claudeAgent", codex: "codex", grok: "grokAgent", gemini: "geminiAgent", muse: "museAgent" };
const TONE_TEXT: Record<ChartTone, string> = { ok: "text-ink", warn: "text-warning", out: "text-danger" };
export const engineName = (engine: string) => ENGINE_NAME[engine] ?? engine;

export type Clock = { t: Translate; locale: string; now: number };

function toneOf(window: UsageBoardWindow | undefined, verdict: Verdict | undefined): ChartTone {
  if (window && window.usedPercent >= 100) return "out";
  return verdict?.kind === "runsOut" ? "warn" : "ok";
}

function sameDay(a: number, b: number) {
  return new Date(a).toDateString() === new Date(b).toDateString();
}
export function clockText(at: number, { locale, now }: Clock) {
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(at);
  return sameDay(at, now) ? time : `${new Intl.DateTimeFormat(locale, { weekday: "short" }).format(at)} ${time}`;
}
const fullText = (at: number, locale: string) =>
  new Intl.DateTimeFormat(locale, { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(at);

export function countdown(ms: number, t: Translate) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < 3600) return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const minutes = Math.floor(seconds / 60);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  return days > 0 ? t("usage.desk.countDh", { days, hours }) : t("usage.desk.countHm", { hours, minutes: minutes % 60 });
}

export function shortLabel(window: UsageBoardWindow, t: Translate) {
  if (window.kind === "session") return t("usage.limits.sessionShort");
  if (window.windowMinutes === 10080 || (window.kind === "week" && window.windowMinutes === null)) return t("usage.limits.weeklyShort");
  return durationText(window.windowMinutes, t);
}
function durationText(minutes: number | null, t: Translate) {
  if (minutes === null) return t("usage.limits.window");
  return minutes >= 2880 && minutes % 1440 === 0 ? t("usage.limits.compactD", { days: minutes / 1440 }) : t("usage.limits.compactH", { hours: Math.round(minutes / 60) });
}

/** Both tracked windows, binding first: `5h 34%` then `7d 59%`, or what the empty slot truly means. */
export function windowFacts(account: UsageBoardAccount, t: Translate) {
  const { session, week } = splitWindows(account.windows);
  const binding = bindingWindow([session, week].filter((window): window is UsageBoardWindow => Boolean(window)))
    ?? bindingWindow(account.windows);
  const fact = (window: UsageBoardWindow) => `${shortLabel(window, t)} ${Math.round(leftOf(window))}%`;
  const other = binding === session ? week : binding === week ? session : undefined;
  // The fact says which window has no data, so "7d 0%" never seems to own it; the bars' one empty state says the same.
  const missing = !session && week ? t("usage.desk.windowNoData", { window: t("usage.limits.sessionShort") }) : null;
  return { binding, first: binding ? fact(binding) : t("usage.desk.noData"), second: other ? fact(other) : binding === week ? missing : null };
}

export function Tile({ number, terminal }: { number: number; terminal: boolean }) {
  return terminal
    ? <span data-tile="" className="usage-glyphs shrink-0 text-[12px] text-ink-secondary">[{number}]</span>
    : <span data-tile="" className="inline-flex size-[18px] shrink-0 items-center justify-center rounded-[3px] [corner-shape:bevel] border border-hairline bg-raised text-[10.5px] leading-none text-ink">{number}</span>;
}

function ResetLine({ slot, window, account, clock }: { slot: "session" | "week" | "extra"; window?: UsageBoardWindow; account: UsageBoardAccount; clock: Clock }) {
  const { t } = clock;
  const label = slot === "extra" && window ? shortLabel(window, t) : t(slot === "session" ? "usage.limits.sessionShort" : "usage.limits.weeklyShort");
  let body: ReactNode;
  if (!window) {
    const week = splitWindows(account.windows).week;
    body = account.coverage !== "complete" ? t("usage.desk.noData")
      : slot === "session" && week ? t("usage.desk.weeklyOnly") : t("usage.desk.notOnPlan");
  } else if (window.resetsAt === null) body = t("usage.limits.resetUnknown");
  else if (windowExpired(window.resetsAt, clock.now)) body = t("usage.desk.resetPassed");
  else body = <>
    <time dateTime={new Date(window.resetsAt).toISOString()} aria-hidden="true" className="text-ink">{clockText(window.resetsAt, clock)}</time>
    <span aria-hidden="true">{t("usage.desk.resetsIn", { time: countdown(window.resetsAt - clock.now, t) })}</span>
    <span className="sr-only">{t("usage.desk.resetsAt", { time: fullText(window.resetsAt, clock.locale) })}</span>
  </>;
  return (
    <div data-reset={slot} className="usage-num flex min-w-0 flex-wrap items-baseline gap-x-3 text-[12.5px] leading-5 text-ink-secondary">
      <span className="min-w-6 shrink-0 whitespace-nowrap">{label}</span>
      {body}
    </div>
  );
}

function verdictText(verdict: Verdict, clock: Clock) {
  const { t } = clock;
  switch (verdict.kind) {
    case "out": return verdict.back === null ? t("usage.limits.checkLimit") : t("usage.desk.back", { time: clockText(verdict.back, clock) });
    case "runsOut": return t("usage.desk.runsOut", { time: clockText(verdict.at, clock) });
    case "lasts": return t("usage.desk.lasts");
    case "learning": return t("usage.desk.learning");
    case "noRecent": return t("usage.desk.noRecent");
    case "awaiting": return t("usage.desk.awaiting");
  }
}

function labelsText(labels: string[], t: Translate) {
  const sorted = [...labels].sort();
  const shown = sorted.slice(0, 3).join(", ");
  return sorted.length > 3 ? t("usage.desk.labelsMore", { labels: shown, count: sorted.length - 3 }) : shown;
}

/** One grey line per kind, newest only, last 24 h; wording only from the event's own names and labels. */
function eventLines(engine: UsageBoardEngine, board: UsageBoard, clock: Clock) {
  const { t } = clock;
  const name = (id?: string) => engine.accounts.find((account) => account.id === id)?.name;
  const recent = engine.events.filter((event) => clock.now - event.at <= 24 * HOUR);
  const newest = (kind: UsageBoardEvent["kind"]) => recent.filter((event) => event.kind === kind).sort((a, b) => b.seq - a.seq)[0];
  const lines: { kind: string; at: number; text: string }[] = [];
  const main = newest("main");
  if (main && name(main.from) && name(main.to)) {
    const old = engine.accounts.find((account) => account.id === main.from)!;
    let text = t("usage.desk.eventMain", { engine: engineName(engine.engine), from: old.name, to: name(main.to)! });
    if (board.runs === "known" && old.workers?.length) text += ` ${t("usage.desk.eventStill", { from: old.name, labels: labelsText(old.workers.map((run) => run.label), t) })}`;
    lines.push({ kind: "main", at: main.at, text });
  }
  const auto = newest("auto");
  if (auto && name(auto.to) && auto.label) {
    const ranOut = auto.from && name(auto.from) && engine.events.some((event) => event.kind === "limit" && event.accountId === auto.from && event.seq < auto.seq);
    const later = engine.events.some((event) => event.kind === "main" && event.seq > auto.seq);
    const parts = [
      ranOut ? t("usage.desk.eventRanOut", { from: name(auto.from)! }) : "",
      t("usage.desk.eventAuto", { label: auto.label, to: name(auto.to)! }),
      !later && name(engine.mainId) ? t("usage.desk.eventMainStays", { main: name(engine.mainId)! }) : "",
    ];
    lines.push({ kind: "auto", at: auto.at, text: parts.filter(Boolean).join(" ") });
  }
  const moved = newest("moved");
  if (moved && name(moved.to) && moved.label) lines.push({ kind: "moved", at: moved.at, text: t("usage.desk.eventMoved", { label: moved.label, to: name(moved.to)! }) });
  return lines.sort((a, b) => b.at - a.at);
}

function Ticker({ board, engineId, select, phone, terminal, clock, instances }: {
  board: UsageBoard; engineId: string; select: (base: string) => void; phone: boolean; terminal: boolean; clock: Clock;
  instances: { instanceId: string; displayName?: string }[];
}) {
  const { t } = clock;
  return (
    <div role="tablist" aria-label={t("usage.desk.engines")} className="grid gap-1 rounded-[3px] [corner-shape:bevel] bg-inset p-1"
      style={{ gridTemplateColumns: phone ? `repeat(${board.engines.length}, auto)` : `repeat(${board.engines.length}, minmax(0, 1fr))` }}>
      {board.engines.map((engine) => {
        const main = engine.accounts.find((account) => account.id === engine.mainId) ?? engine.accounts[0];
        const facts = main ? windowFacts(main, t) : null;
        const selected = engine.base === engineId;
        const label = engineLabel(board, engine, instances);
        const series = main && facts?.binding ? chartSeries(main, facts.binding, engine.events, clock.now) : null;
        const tone = toneOf(facts?.binding, undefined);
        return (
          <button key={engine.base} type="button" role="tab" data-engine={engine.engine} aria-selected={selected} onClick={() => select(engine.base)}
            className={cn("flex min-w-0 flex-col items-start gap-1 rounded-[3px] [corner-shape:bevel] py-1.5 text-left", phone ? "px-1.5" : "px-2",
              " transition-colors duration-100 motion-reduce:transition-none",
              selected ? "bg-raised" : "hover:bg-raised-hover")}>
            <span className="max-w-full truncate text-[11.5px] leading-none text-ink-secondary">{label}</span>
            <span className="flex w-full items-end justify-between gap-1">
              <span className="usage-num min-w-0">
                <span className={cn("block leading-tight", phone ? "whitespace-nowrap text-[12px]" : "truncate text-[13px]", TONE_TEXT[tone])}>{facts?.first}</span>
                <span className={cn("block leading-tight text-ink-secondary", phone ? "whitespace-nowrap text-[10.5px]" : "truncate text-[11px]")}>{facts?.second ?? " "}</span>
              </span>
              {!phone && <UsageSpark series={series} tone={tone} terminal={terminal} />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Who({ account, runs, control, t }: { account: UsageBoardAccount; runs: UsageBoard["runs"]; control: ReactNode; t: Translate }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const names = [...new Set(account.bots.map((bot) => bot.bot))];
  const bots = t(names.length === 1 ? "usage.desk.botOne" : "usage.desk.bots", { count: names.length });
  const workers = runs !== "known" || account.workers === null ? t("usage.desk.workersUnknown")
    : t(account.workers.length === 1 ? "usage.desk.workerOne" : "usage.desk.workers", { count: account.workers.length });
  // Counts on every surface; the bot count opens the names. Main or Use ends this line, so the name above keeps the whole width.
  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <span data-account-who="" className="flex min-w-0 flex-1 items-center gap-1.5 text-[12.5px] leading-5 text-ink-secondary">
          {names.length > 0
            ? <button type="button" data-bot-count="" aria-expanded={open} aria-controls={id} onClick={(event) => { event.stopPropagation(); setOpen(!open); }}
              className="relative shrink-0 rounded-[3px] [corner-shape:bevel] underline-offset-2 hover:underline [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:inset-x-0 [@media(pointer:coarse)]:after:-inset-y-3">{bots}</button>
            : <span className="shrink-0">{bots}</span>}
          <span aria-hidden="true">·</span>
          <span className="min-w-0 truncate">{workers}</span>
        </span>
        {control}
      </div>
      {names.length > 0 && <Fold open={open} id={id}><span className="block text-[12.5px] leading-5 text-ink-secondary">{names.join(", ")}</span></Fold>}
    </>
  );
}

const SIGN_IN_KEY = { "signing-in": "usage.desk.signingIn", "signed-out": "accounts.signedOut", draining: "usage.desk.draining", unknown: "usage.desk.statusUnknown" } as const;
/** Main and Use share one box: same width, height and shape; a larger touch target sits outside it on phones. */
const CONTROL = "relative inline-flex min-h-7 w-[4.5rem] shrink-0 items-center justify-center rounded-[3px] [corner-shape:bevel] border px-1 text-center text-[12px] leading-tight [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:inset-x-0 [@media(pointer:coarse)]:after:-inset-y-2";

/** Today's account block: tile and name, then bots and workers with Main or Use, then the bars. */
export function AccountRow({ engine, account, board, state, checked, terminal, clock, reloadInstances, name }: {
  engine: UsageBoardEngine; account: UsageBoardAccount; board: UsageBoard; state: UsageBoardState; checked: boolean;
  terminal: boolean; clock: Clock; reloadInstances: () => unknown;
} & RowSlots) {
  const { t } = clock;
  const pending = state.pending[engine.base];
  const switching = pending?.target === account.id;
  let control: ReactNode;
  if (account.signIn !== "ready") control = <span data-row-status="" className={cn(CONTROL, "border-transparent text-ink-secondary")}>{t(SIGN_IN_KEY[account.signIn])}</span>;
  else if (checked) control = <span data-main-check="" className={cn(CONTROL, "border-hairline/40 bg-raised text-ink")}>{t("accounts.main")}</span>;
  else control = (
    <button type="button" data-use="" aria-label={switching ? undefined : t("usage.desk.useAria", { name: account.name })}
      aria-busy={switching || undefined} aria-disabled={Boolean(pending) || undefined}
      onClick={() => requestMain(engine.base, account.id, reloadInstances)}
      className={cn(CONTROL, "whitespace-nowrap border-hairline/40 text-ink-secondary transition-colors duration-100 hover:bg-raised-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-accent motion-reduce:transition-none",
        pending && !switching && "opacity-50")}>
      {switching ? t("usage.desk.switching") : t("usage.desk.use")}
    </button>
  );
  return (
    <div data-account-row={account.id} tabIndex={-1} className="min-w-0 rounded-[3px] [corner-shape:bevel] outline-none">
      <div data-account-head="" className="flex min-h-7 min-w-0 items-center gap-2">
        <Tile number={account.number} terminal={terminal} />
        {name ? <span className="flex min-w-0 flex-1">{name}</span>
          : <span data-account-name="" className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{account.name}</span>}
      </div>
      <Who account={account} runs={board.runs} control={control} t={t} />
      <div className="mt-2"><AccountBars engine={engine.engine} account={account} now={clock.now} t={t} /></div>
    </div>
  );
}

export function Hero({ engine, account, accounts, select, terminal, phone, clock, instances, foldChart = false }: {
  engine: UsageBoardEngine; account: UsageBoardAccount; accounts: UsageBoardAccount[]; select: (id: string) => void;
  terminal: boolean; phone: boolean; clock: Clock; instances: { instanceId: string; capabilities?: { rateLimits?: boolean } }[]; foldChart?: boolean;
}) {
  const { t } = clock;
  const ref = useRef<HTMLElement>(null);
  const [details, setDetails] = useState(false);
  const [chartOpen, setChartOpen] = useState(!foldChart);
  const chartId = useId();
  const detailsId = useId();
  const shown = useRef(account.id);
  useLayoutEffect(() => {
    if (shown.current === account.id) return;
    shown.current = account.id;
    if (!reducedMotion()) ref.current?.animate?.([{ opacity: 0.55 }, { opacity: 1 }], { duration: MOTION_FAST_MS, easing: EASE_ENTRANCE });
  }, [account.id]);
  const { session, week } = splitWindows(account.windows);
  const facts = windowFacts(account, t);
  const window = facts.binding;
  // An extra window (Gemini daily, a Codex slot of another length) keeps no history: no pace line and no chart for it.
  const paced = window && historyColumn(account, window) !== null ? window : undefined;
  const { verdict, projection } = paced ? pace(account, paced, engine.events, clock.now) : { verdict: undefined, projection: null };
  const tone = toneOf(window, verdict);
  const series = paced ? chartSeries(account, paced, engine.events, clock.now) : null;
  const muse = engine.engine === "muse" ? museReading("museAgent", account.observedAt === null ? undefined : new Date(account.observedAt).toISOString(), clock.now) : null;
  const limited = engine.engine === "muse" && account.windows.find((each) => each.usedPercent >= 100 && !windowExpired(each.resetsAt, clock.now));
  const limitReset = limited ? resetCompact(limited.resetsAt, clock.now) : null;
  const vs = week ? todayVsNormal(account, clock.now) : null;
  const vsText = vs === null ? null : vs >= 1.15 ? t("usage.desk.todayVs", { times: vs >= 2 ? Math.round(vs) : vs.toFixed(1) })
    : vs <= 0.85 ? t("usage.desk.todayLess") : t("usage.desk.todayNormal");
  const reports = instances.find((each) => each.instanceId === account.id)?.capabilities?.rateLimits !== false;
  let empty: string | null = null;
  if (!reports) empty = t("usage.limits.notReported", { name: account.name });
  else if (account.signIn !== "ready" && account.observedAt === null) empty = t(SIGN_IN_KEY[account.signIn]);
  else if (account.observedAt === null) empty = t("usage.desk.noReport");
  return (
    <section ref={ref} data-usage-hero="" data-stale={muse?.stale || undefined} aria-label={account.name} className="min-w-0">
      <div className="flex min-h-7 min-w-0 items-center gap-2">
        <ProviderMark driverKind={ENGINE_DRIVER[engine.engine] ?? engine.engine} size={16} />
        {accounts.length > 1 && <Tile number={account.number} terminal={terminal} />}
        {accounts.length > 1
          ? <AccountPicker accounts={accounts} viewedId={account.id} select={select} />
          : <span data-hero-name="" className="min-w-0 truncate text-[13.5px] font-medium text-ink">{account.name}</span>}
      </div>
      {empty ? <div className="mt-3"><EmptyState>{empty}</EmptyState></div> : <>
        <div className="mt-1.5 flex min-w-0 flex-wrap items-end justify-between gap-x-4 gap-y-1">
          <span className={cn("flex items-baseline gap-1.5", muse?.stale && "opacity-60")}>
            <span data-hero-left="" className={cn("usage-num text-[38px] font-normal leading-none tracking-tight", TONE_TEXT[tone])}>
              {window ? `${Math.round(leftOf(window))}%` : "–"}
            </span>
            {window && <span className="text-[13px] text-ink-secondary">{t("usage.desk.left")}</span>}
          </span>
          {verdict && <span data-verdict="" className={cn("pb-0.5 text-[13px]",
            verdict.kind === "learning" || verdict.kind === "noRecent" || verdict.kind === "awaiting" ? "text-ink-secondary" : TONE_TEXT[tone])}>
            {verdictText(verdict, clock)}
          </span>}
        </div>
        <div className="mt-2 flex flex-col">
          <ResetLine slot="session" window={session} account={account} clock={clock} />
          <ResetLine slot="week" window={week} account={account} clock={clock} />
          {window && !paced && <ResetLine slot="extra" window={window} account={account} clock={clock} />}
        </div>
        {muse && <div className={cn("mt-1 text-[12px]", muse.stale ? "text-ink-secondary opacity-70" : "text-ink-secondary")}>{muse.label(t)}</div>}
        {limited && <div className="mt-1 text-[12px] text-danger">
          {limitReset ? t("usage.limits.checkLimitResets", { time: t(limitReset.key, limitReset.vars) }) : t("usage.limits.checkLimit")}
        </div>}
        {foldChart && paced && <button type="button" data-chart-fold="" aria-expanded={chartOpen} aria-controls={chartId} onClick={() => setChartOpen(!chartOpen)}
          className="mt-2 inline-flex h-7 items-center rounded-[3px] [corner-shape:bevel] px-1.5 text-[12px] text-ink-secondary hover:bg-raised-hover [@media(pointer:coarse)]:h-11">
          {t("usage.chat.chart")}
        </button>}
        <Fold open={chartOpen} id={chartId}><div className="mt-3">
          {series && series.segments.length > 0
            ? <UsageChart series={series} projection={projection} tone={tone} terminal={terminal} compact={phone}
              caption={t("usage.desk.quota")} topLeft={vsText && <span data-today-normal="">{vsText}</span>}
              finish={window?.resetsAt != null && window.resetsAt > clock.now ? clockText(window.resetsAt, clock) : undefined} />
            : paced && <EmptyState>{t("usage.desk.noHistory")}</EmptyState>}
        </div></Fold>
      </>}
      {account.windows.length > 0 && <>
        <button type="button" data-details="" aria-expanded={details} aria-controls={detailsId} onClick={() => setDetails(!details)}
          className="mt-2 inline-flex h-7 items-center rounded-[3px] [corner-shape:bevel] px-1.5 text-[12px] text-ink-secondary hover:bg-raised-hover [@media(pointer:coarse)]:h-11">
          {t("usage.desk.details")}
        </button>
        <Fold open={details} id={detailsId}>
          <div data-details-body="" className="usage-num flex flex-col gap-0.5 px-1.5 pb-1 text-[12px] text-ink-secondary">
            {account.windows.map((each) => (
              <span key={each.id} className="flex flex-wrap gap-x-3">
                <span className="text-ink">{each.id.includes("opus") ? `${t("usage.limits.opusShort")} ${shortLabel(each, t)}` : shortLabel(each, t)}</span>
                <span>{t("usage.desk.windowLeft", { percent: Math.round(leftOf(each)) })}</span>
                <span>{each.resetsAt === null ? t("usage.limits.resetUnknown") : windowExpired(each.resetsAt, clock.now)
                  ? t("usage.desk.resetPassed") : t("usage.desk.resetsAt", { time: clockText(each.resetsAt, clock) })}</span>
              </span>
            ))}
          </div>
        </Fold>
      </>}
    </section>
  );
}

/** Hidden for the bars-first look: the engine strip, hero, chart and event lines stay in code, not rendered. */
const SHOW_DESK_HERO = false;

function EngineSection({ engine, board, state, stacked, terminal, clock, label, reloadInstances }: {
  engine: UsageBoardEngine; board: UsageBoard; state: UsageBoardState; stacked: boolean; terminal: boolean; clock: Clock; label: string;
  reloadInstances: () => unknown;
}) {
  const { t } = clock;
  const checked = checkedMain(state, engine.base);
  const row = (account: UsageBoardAccount, slots?: RowSlots) => <AccountRow key={account.id} engine={engine} account={account} board={board} state={state}
    checked={account.id === checked} terminal={terminal} clock={clock} reloadInstances={reloadInstances} {...slots} />;
  const head = (arrows?: ReactNode) => (
    <div className="flex min-h-9 min-w-0 items-center gap-2">
      <span data-engine-mark="" className={cn("flex shrink-0", terminal ? "usage-glyphs w-[3ch] text-[12px]" : "w-[18px]")}><ProviderMark driverKind={ENGINE_DRIVER[engine.engine] ?? engine.engine} size={16} /></span>
      <span data-engine-name="" className="min-w-0 flex-1 truncate text-[13px] text-ink">{label}</span>
      {arrows}
    </div>
  );
  return (
    <section data-usage-engine={engine.engine} aria-label={label} className="min-w-0">
      {USAGE_LAYOUT === "A" ? <PagedAccounts engine={engine} checked={checked} stacked={stacked} t={t} head={head} row={row} /> : <>
        {head()}
        <div role="group" aria-label={label} className={cn("mt-1 grid min-w-0 gap-y-4", !stacked && "grid-cols-2 gap-x-8")}>{engine.accounts.map((each) => row(each))}</div>
      </>}
      {state.failed.has(engine.base) && <div role="alert" className="mt-2 text-[12px] text-danger">{t("usage.desk.mainFailed")}</div>}
    </section>
  );
}

/** One engine label per board group: the instance's own name when two groups share a driver. */
export function engineLabel(board: UsageBoard, engine: UsageBoardEngine, instances: { instanceId: string; displayName?: string }[]) {
  const twin = board.engines.some((other) => other !== engine && other.engine === engine.engine);
  return (twin && instances.find((each) => each.instanceId === engine.base)?.displayName) || engineName(engine.engine);
}

/** Settings > Usage: every engine under its own header, every account as Today's block with its 5h and 7d bars. */
export function UsageDesk() {
  const { t, locale } = useI18n();
  const { state: store, refreshInstances } = useStore();
  const state = useUsageBoard();
  const phone = useIsPhone();
  const terminal = isTerminalSkin(useSkin());
  const [engineId, setEngineId] = useState<string | null>(null);
  const [viewed, setViewed] = useState<Record<string, string>>({});
  const now = useVisibleClock();
  const clock: Clock = { t, locale: localeTag(locale), now };
  const board = state.board;
  if (!board) return <div data-usage-desk="" className="min-w-0"><EmptyState>{t(state.status === "error" ? "usage.desk.unavailable" : "usage.desk.loading")}</EmptyState></div>;
  if (!board.engines.some((each) => each.accounts.length)) return <div data-usage-desk="" className="min-w-0"><EmptyState>{t("usage.limits.empty")}</EmptyState></div>;
  const engine = board.engines.find((each) => each.base === engineId) ?? board.engines[0]!;
  const account = engine.accounts.find((each) => each.id === viewed[engine.base]) ?? engine.accounts.find((each) => each.id === engine.mainId) ?? engine.accounts[0];
  return (
    <div data-usage-desk="" className="flex min-w-0 flex-col gap-5">
      {state.status === "error" && <div role="status" data-board-status="" className="text-[12px] text-ink-secondary">{t("usage.desk.stale")}</div>}
      {board.engines.filter((each) => each.accounts.length).map((each) => <EngineSection key={each.base} engine={each} board={board} state={state} stacked={phone}
        terminal={terminal} clock={clock} label={engineLabel(board, each, store.instances)} reloadInstances={() => refreshInstances()} />)}
      {SHOW_DESK_HERO && account && <>
        <Ticker board={board} engineId={engine.base} select={setEngineId} phone={phone} terminal={terminal} clock={clock} instances={store.instances} />
        <Hero key={engine.base} engine={engine} account={account} accounts={engine.accounts} terminal={terminal} phone={phone} clock={clock}
          instances={store.instances} select={(id) => setViewed((current) => ({ ...current, [engine.base]: id }))} />
        {eventLines(engine, board, clock).map((line) => (
          <div key={line.kind} data-usage-event={line.kind} className="usage-num -mt-2 flex min-w-0 gap-2 text-[12px] leading-5 text-ink-secondary">
            <span className="min-w-0">{line.text}</span>
            <span className="shrink-0">{clockText(line.at, clock)}</span>
          </div>
        ))}
      </>}
    </div>
  );
}
