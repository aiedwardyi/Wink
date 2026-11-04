// The usage desk: one ticker per engine, one hero chart, and the accounts as a picker.
// Glance at the strip, read the verdict, tap a row to move new work. Nothing else.
import { Check } from "lucide-react";
import { cn } from "@/lib/cn";
import { isTerminalSkin, useSkin } from "@/lib/skins";
import { DAY, HOUR, type EngineId, type FxSwitch, type Kind } from "./fixtures";
import { binding, leftOf, live, roundTo10Min, startOf, todayVsNormal, verdict, type Verdict, type Win } from "./pace";
import { accountsOf, deskNow, engineName, focusEngine, label, pickChip, togglePin, use, useDesk, useTick, type Account } from "./desk-store";
import { RaceChart, Spark, TONE_TEXT, toneOf, type Tone } from "./Chart";
import { useDeskText, type DeskText } from "./strings";
import { useEased } from "./motion";

export const ENGINE_ORDER: EngineId[] = ["claude", "codex", "grok", "gemini"];
type DeskState = ReturnType<typeof useDesk>;

// Seoul has no daylight time; the build uses the device zone.
const ZONE_OFFSET = 9 * HOUR;
export const dayStart = (t: number) => Math.floor((t + ZONE_OFFSET) / DAY) * DAY - ZONE_OFFSET;

export type Line = { account: Account; win?: Win; verdict: Verdict; left: number | null; tone: Tone };

export function lineOf(account: Account, now: number, kind?: Kind): Line {
  const open = account.wins.filter((w) => live(w, now));
  const win = (kind && open.find((w) => w.kind === kind)) || binding(open, now);
  const v = verdict(win, now);
  return { account, win, verdict: v, left: win ? leftOf(win) : null, tone: toneOf(v) };
}

/** Where Wink would move new work next: room left, soonest weekly reset first. */
function nextFor(lines: Line[], inUse: Account) {
  const weekReset = (a: Account) => a.wins.find((w) => w.kind === "week")?.resetsAt ?? Infinity;
  return lines
    .filter((l) => l.account !== inUse && l.left !== null && l.left > 10)
    .sort((a, b) => weekReset(a.account) - weekReset(b.account))[0]?.account;
}

export function engineView(s: DeskState, engine: EngineId, now: number) {
  const accounts = accountsOf(s, engine);
  const inUse = accounts.find((a) => a.id === s.inUse[engine]) ?? accounts[0]!;
  const lines = accounts.map((a) => lineOf(a, now));
  const hero = lineOf(inUse, now, s.chip[inUse.id]);
  const ticker = lines[accounts.indexOf(inUse)]!;
  const next = s.pinned[engine] ? undefined : nextFor(lines, inUse);
  const note = s.note[engine];
  return { engine, accounts, inUse, lines, hero, ticker, next, pinned: s.pinned[engine], note, single: accounts.length === 1 };
}

export function verdictText(x: DeskText, line: Line, now: number, next?: Account) {
  const v = line.verdict;
  const resets = line.win ? x.t("resets", { time: x.when(line.win.resetsAt, now) }) : "";
  if (v.kind === "out") return { main: x.t("out"), sub: x.t("back", { time: x.when(v.back, now) }) };
  if (v.kind === "runsOut") return { main: x.t("runsOut", { time: x.when(roundTo10Min(v.at), now) }), sub: next ? x.t("then", { to: label(next) }) : resets };
  if (v.kind === "lasts") return { main: x.t("lasts"), sub: resets };
  return { main: x.t("noData"), sub: "" };
}

export function chartLabels(x: DeskText, line: Line, now: number, engine: EngineId, accounts: Account[]) {
  const win = line.win!;
  const start = startOf(win);
  const ends = line.verdict.kind === "out" ? line.verdict.back : win.resetsAt;
  const name = (n: number) => {
    const a = accounts.find((each) => each.n === n);
    return a ? label(a) : `${engineName(engine)} ${n}`;
  };
  const marker = (m: FxSwitch) => (m.by === "auto" ? x.t("ranOut", { from: name(m.from), to: String(m.to) }) : x.t("youMoved", { to: name(m.to) }));
  const vs = win.kind === "week" ? todayVsNormal(win, now, dayStart) : null;
  let topLeft = "";
  if (vs && vs.normal > 0) {
    const times = vs.today / vs.normal;
    topLeft = times >= 1.15 ? x.t("todayVs", { x: times >= 2 ? Math.round(times) : times.toFixed(1) }) : times <= 0.85 ? x.t("todayLess") : x.t("todayNormal");
  }
  const days: { at: number; text: string }[] = [];
  if (win.kind === "week") for (let d = dayStart(start) + 12 * HOUR; d < win.resetsAt; d += DAY) if (d > start) days.push({ at: d, text: x.weekday(d) });
  return {
    labels: {
      start: x.clock(start),
      end: x.clock(win.resetsAt),
      countdown: x.countdown(ends - now),
      runOut: line.verdict.kind === "runsOut" ? `~${x.when(roundTo10Min(line.verdict.at), now)}` : undefined,
      topLeft,
      days: win.kind === "week" ? days : undefined,
      marker,
    },
    normal: vs?.normal ?? null,
  };
}

export function Pct({ value, tone, className }: { value: number | null; tone: Tone; className?: string }) {
  const eased = useEased(value ?? 0);
  if (value === null) return <span className={cn("desk-num font-semibold leading-none text-ink-secondary", className)}>—</span>;
  return <span className={cn("desk-num font-semibold leading-none", TONE_TEXT[tone], className)}>{Math.round(eased)}%</span>;
}

/** The stable account number. Given at sign-in, never reused, never an email. */
export function Tile({ n, className }: { n: number; className?: string }) {
  const terminal = isTerminalSkin(useSkin());
  if (terminal) return <span className={cn("desk-braille shrink-0 text-[12px] text-ink-secondary", className)}>[{n}]</span>;
  return (
    <span className={cn("inline-flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border border-hairline bg-raised text-[10.5px] font-semibold leading-none text-ink", className)}>
      {n}
    </span>
  );
}

export function TickerStrip({ phone }: { phone?: boolean }) {
  const s = useDesk();
  const now = useTick(1000);
  const x = useDeskText();
  return (
    <div role="tablist" aria-label={x.t("usage")} className="grid grid-cols-4 gap-1 rounded-xl bg-inset p-1">
      {ENGINE_ORDER.map((engine) => {
        const { ticker } = engineView(s, engine, now);
        const selected = s.focus === engine;
        return (
          <button key={engine} type="button" role="tab" aria-selected={selected} onClick={() => focusEngine(engine)}
            aria-label={ticker.left === null ? engineName(engine) : x.t("leftAria", { name: engineName(engine), pct: Math.round(ticker.left) })}
            className={cn(
              "flex min-w-0 flex-col items-start gap-1.5 rounded-lg text-left transition-colors",
              phone ? "px-2.5 py-2" : "px-3 py-2.5",
              selected ? "bg-raised shadow-sm" : "hover:bg-raised-hover/60",
            )}>
            <span className="max-w-full truncate text-[11.5px] leading-none text-ink-secondary">{engineName(engine)}</span>
            <span className="flex w-full items-end justify-between gap-2">
              <Pct value={ticker.left} tone={ticker.tone} className={phone ? "text-[17px]" : "text-[18px]"} />
              {!phone && <Spark win={ticker.win} now={now} verdict={ticker.verdict} width={44} height={16} cols={5} live={selected && ticker.left !== null} />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Chips({ kinds, value, onPick, x }: { kinds: Kind[]; value?: Kind; onPick: (k: Kind) => void; x: DeskText }) {
  return (
    <div role="radiogroup" className="flex shrink-0 rounded-lg bg-inset p-0.5">
      {kinds.map((k) => (
        <button key={k} type="button" role="radio" aria-checked={value === k} onClick={() => onPick(k)}
          className={cn(
            "rounded-md px-2.5 py-1 text-[12px] leading-none transition-colors [@media(pointer:coarse)]:px-3 [@media(pointer:coarse)]:py-1.5",
            value === k ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
          )}>
          {k === "5h" ? x.t("fiveHour") : x.t("week")}
        </button>
      ))}
    </div>
  );
}

/** Dotted guide only: where the line will run once the engine reports. Minimal, not empty. */
function EmptyChart({ height, text }: { height: number; text: string }) {
  return (
    <div className="relative w-full" style={{ height }}>
      <svg className="absolute inset-0 h-full w-full" preserveAspectRatio="none" viewBox="0 0 100 100" aria-hidden="true">
        <line x1={0} y1={12} x2={100} y2={84} stroke="var(--color-ink-secondary)" strokeOpacity={0.35} strokeWidth={1.2} strokeDasharray="0 4" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        <line x1={0} x2={100} y1={84.5} y2={84.5} stroke="var(--color-hairline)" vectorEffect="non-scaling-stroke" />
      </svg>
      <span className="absolute inset-x-0 top-[38%] text-center text-[12.5px] text-ink-secondary">{text}</span>
    </div>
  );
}

export function Hero({ engine, size, phone }: { engine: EngineId; size: "page" | "compact"; phone?: boolean }) {
  const s = useDesk();
  const now = useTick(1000);
  const x = useDeskText();
  const view = engineView(s, engine, now);
  const { hero, next, note, single, accounts } = view;
  const account = hero.account;
  const text = verdictText(x, hero, now, next);
  const kinds = account.wins.filter((w) => live(w, now)).map((w) => w.kind);
  const markers = s.switches.filter((m) => m.engine === engine && (m.to === account.n || m.from === account.n));
  const chart = hero.win ? chartLabels(x, hero, now, engine, accounts) : null;
  const fromAccount = note && accounts.find((a) => a.n === note.from);
  const big = size === "page" ? (phone ? "text-[38px]" : "text-[40px]") : "text-[30px]";
  return (
    <section aria-label={label(account)} className="min-w-0">
      <div className="flex min-h-7 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {single ? <span className="truncate text-[13.5px] font-medium text-ink">{engineName(engine)}</span> : (
            <>
              <Tile n={account.n} />
              <span className="truncate text-[13.5px] font-medium text-ink">{label(account)}</span>
              <span className="shrink-0 text-[12px] text-ink-secondary">{x.t("inUse")}</span>
            </>
          )}
        </div>
        {kinds.length > 1 && <Chips kinds={kinds} value={hero.win?.kind} onPick={(k) => pickChip(account.id, k)} x={x} />}
      </div>
      <div className="mt-1.5 flex items-end justify-between gap-4">
        <div className="flex items-baseline gap-1.5">
          <Pct value={hero.left} tone={hero.tone} className={cn(big, "tracking-tight")} />
          {hero.left !== null && <span className="text-[14px] text-ink-secondary">{x.t("left")}</span>}
        </div>
        {hero.left !== null && (
          <div className="min-w-0 pb-0.5 text-right">
            <div className={cn("truncate text-[13.5px] font-medium leading-snug", TONE_TEXT[hero.tone])}>{text.main}</div>
            {text.sub && <div className="desk-num truncate text-[12px] leading-snug text-ink-secondary">{text.sub}</div>}
          </div>
        )}
      </div>
      <div className={size === "page" ? "mt-3" : "mt-2"}>
        {hero.win && chart ? (
          <RaceChart win={hero.win} now={now} verdict={hero.verdict} live={!s.lapsing || engine !== "codex"} markers={markers} size={size} labels={chart.labels} normal={chart.normal} />
        ) : (
          <EmptyChart height={size === "page" ? 150 : 96} text={text.main} />
        )}
      </div>
      {note && fromAccount && (
        <div key={`${note.engine}${note.at}`} className="desk-fade mt-2 flex min-w-0 items-center gap-2 text-[12px] text-ink-secondary">
          <span className="truncate">{x.t("ranOut", { from: label(fromAccount), to: String(note.to) })}</span>
          <span className="desk-num shrink-0">{x.when(note.at, now)}</span>
        </div>
      )}
    </section>
  );
}

function rowSub(x: DeskText, line: Line, now: number) {
  if (line.verdict.kind === "out") return x.t("back", { time: x.when(line.verdict.back, now) });
  if (line.left === null) return x.t("noData");
  const shares = new Map<string, number>();
  for (const w of line.account.working) {
    const bot = w.name.split(" · ")[0]!;
    shares.set(bot, (shares.get(bot) ?? 0) + w.share);
  }
  const names = [...shares].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  return names.length ? names.join(", ") : x.t("idle");
}

export function AccountList({ engine, size, footer }: { engine: EngineId; size: "page" | "compact"; footer?: React.ReactNode }) {
  const s = useDesk();
  const now = useTick(1000);
  const x = useDeskText();
  const view = engineView(s, engine, now);
  if (view.single) return footer ? <div className="overflow-hidden rounded-xl bg-inset">{footer}</div> : null;
  const rowH = size === "page" ? 52 : 46;
  const checked = Math.max(0, view.accounts.findIndex((a) => a.id === (s.pending ?? s.inUse[engine])));
  return (
    <div className="overflow-hidden rounded-xl bg-inset">
      <div role="radiogroup" aria-label={engineName(engine)} className="relative">
        <span aria-hidden="true" className={cn("desk-check pointer-events-none absolute left-0 top-0 flex w-9 items-center justify-center text-accent", s.pending && "desk-pending")}
          style={{ height: rowH, transform: `translateY(${checked * rowH}px)` }}>
          <Check size={16} strokeWidth={2.5} />
        </span>
        {view.accounts.map((a, i) => {
          const line = view.lines[i]!;
          const inUse = a.id === s.inUse[engine];
          const out = line.verdict.kind === "out";
          return (
            <button key={a.id} type="button" role="radio" aria-checked={inUse} disabled={out} onClick={() => use(engine, a.id)}
              aria-label={line.left === null ? label(a) : x.t("leftAria", { name: label(a), pct: Math.round(line.left) })}
              className={cn("flex w-full items-center gap-3 pl-9 pr-4 text-left transition-colors", i > 0 && "border-t border-hairline/50", !out && !inUse && "hover:bg-raised-hover/50")}
              style={{ height: rowH }}>
              <Tile n={a.n} />
              <span className="min-w-0 flex-1">
                <span className={cn("block truncate text-[13.5px] leading-tight", out ? "text-ink-secondary" : "text-ink")}>{label(a)}</span>
                <span className="desk-num mt-0.5 block truncate text-[12px] leading-tight text-ink-secondary">{rowSub(x, line, now)}</span>
              </span>
              <Spark win={line.win} now={now} verdict={line.verdict} width={size === "page" ? 64 : 52} height={18} live={inUse} cols={size === "page" ? 8 : 6} />
              <Pct value={line.left} tone={line.tone} className="w-11 shrink-0 text-right text-[14px]" />
            </button>
          );
        })}
      </div>
      {footer ?? <PinRow engine={engine} />}
    </div>
  );
}

export function PinRow({ engine }: { engine: EngineId }) {
  const s = useDesk();
  const x = useDeskText();
  const now = deskNow();
  const view = engineView(s, engine, now);
  const name = label(view.inUse);
  return (
    <div className="flex items-center justify-between gap-3 border-t border-hairline/50 px-4" style={{ minHeight: 52 }}>
      <span className="min-w-0 py-2">
        <span className="block truncate text-[13.5px] leading-tight text-ink">{x.t("stayOn", { n: name })}</span>
        <span className="mt-0.5 block truncate text-[12px] leading-tight text-ink-secondary">{x.t("noMoves")}</span>
      </span>
      <button type="button" role="switch" aria-checked={view.pinned} aria-label={x.t("stayOn", { n: name })} onClick={() => togglePin(engine)}
        className={cn("relative h-6 w-11 shrink-0 rounded-full transition-colors", view.pinned ? "bg-accent" : "bg-control")}>
        <span className={cn("absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white transition-all", view.pinned ? "left-[21px]" : "left-[3px]")} />
      </button>
    </div>
  );
}

/** The whole page: strip, hero, accounts. Same pieces on desktop and phone. */
export function Desk({ phone }: { phone?: boolean }) {
  const s = useDesk();
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <TickerStrip phone={phone} />
      <Hero engine={s.focus} size="page" phone={phone} />
      <AccountList engine={s.focus} size="page" />
    </div>
  );
}

