import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Activity, Archive, BookOpen, Brain, ChevronDown, ChevronRight, FileText, Moon, Pencil, Repeat, Sparkle, Undo2, X } from "lucide-react";
import type { AppState, Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { localeTag, useI18n, type MessageKey } from "@/lib/i18n";
import { memoryMap, LEARNED_SHOWN, type MemoryFact } from "@/lib/memory-map";
import { currentTask, NotedLines, type MemoryTopic } from "./MemoryGroups";
import { AURA, fadePanel, openFold, openMist, openPanel, playOpen, softwareRender, type OpenParts } from "./MemoryMapMotion";
import { TopicRows } from "./MemoryTopics";
import { Fold } from "./Fold";
import { liveHeight, STACK_BELOW, useStage } from "./MemoryMapStage";
import "./MemoryMap.css";

export interface SleepReadout {
  sleptAt: Date;
  kept: number;
  merged: number;
  forgot: number;
  learned: number;
  onUndo: () => void;
}

type Kind = "long" | "knowledge" | "muscle";

const DOTS = 40;

const UNITS = {
  long: ["bot.memoryFactsOne", "bot.memoryFacts"],
  knowledge: ["bot.memoryFilesOne", "bot.memoryFiles"],
  muscle: ["bot.memoryLessonsOne", "bot.memoryLessons"],
} satisfies Record<string, [MessageKey, MessageKey]>;

const KINDS = {
  long: { icon: Archive, name: "bot.memoryLongTerm", hint: "bot.memoryLongTermHint", slot: "mm-left", side: "left" },
  knowledge: { icon: BookOpen, name: "bot.memoryKnowledge", hint: "bot.memoryKnowledgeHint", slot: "mm-right", side: "right" },
  muscle: { icon: Repeat, name: "bot.memoryMuscle", hint: "bot.memoryMuscleHint", slot: "mm-bottom", side: "bottom" },
} as const satisfies Record<Kind, { icon: typeof Archive; name: MessageKey; hint: MessageKey; slot: string; side: OpenParts["side"] }>;

let seed = 7;
const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
const SPECKS = Array.from({ length: 26 }, () => ({ left: `${rnd() * 100}%`, top: `${rnd() * 100}%`, opacity: 0.35 + rnd() * 0.5, scale: 0.6 + rnd() }));

// null is an unread count: a dash, never a 0 that reads as empty memory
function Count({ kind, count }: { kind: keyof typeof UNITS; count: number | null }) {
  const { t } = useI18n();
  return (
    <span className="mm-count">
      <b>{count ?? "–"}</b>
      {count !== null && <span>{t(UNITS[kind][count === 1 ? 0 : 1])}</span>}
    </span>
  );
}

export function SleepLine({ sleep }: { sleep: SleepReadout }) {
  const { t, locale } = useI18n();
  const time = new Intl.DateTimeFormat(localeTag(locale), { hour: "numeric", minute: "2-digit" }).format(sleep.sleptAt);
  return (
    <div className="mm-sleep">
      <span className="mm-sleep-when"><Moon size={15} aria-hidden="true" />{t("bot.memorySlept", { time })}</span>
      <span className="mm-sleep-stats">
        {([["bot.memorySleepKept", sleep.kept], ["bot.memorySleepMerged", sleep.merged], ["bot.memorySleepForgot", sleep.forgot], ["bot.memorySleepLearned", sleep.learned]] as const).map(([key, value]) => (
          <span key={key}>{t(key)}<b>{value}</b></span>
        ))}
      </span>
      <button type="button" className="mm-undo" onClick={sleep.onUndo}><Undo2 size={13} aria-hidden="true" />{t("chrome.undo")}</button>
    </div>
  );
}

function FactList({ facts, day, fresh }: { facts: MemoryFact[]; day: Intl.DateTimeFormat; fresh?: ReadonlySet<string> }) {
  return (
    <ul className="mm-list">
      {facts.map((each) => (
        <li key={each.line} data-fresh={fresh?.has(each.line) || undefined}>
          <span className="mm-list-text">{each.fact}</span>
          <span className="mm-date">{each.at ? day.format(each.at) : ""}</span>
        </li>
      ))}
    </ul>
  );
}

export function MemoryMap({ bot, text, topics, target, active, sleep = null, failed = false, onRetry, editor, saveState, editing = false, onEditing, onStack }: {
  bot: Bot;
  text: string;
  topics: MemoryTopic[];
  target?: AppState["settingsMemoryTarget"];
  active: boolean;
  sleep?: SleepReadout | null;
  failed?: boolean;
  onRetry?: () => void;
  /** the memory file editor; on the wide map it opens over the three kinds */
  editor?: ReactNode;
  saveState?: ReactNode;
  editing?: boolean;
  onEditing?: (editing: boolean) => void;
  onStack?: (stacked: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const gradient = `mm${useId().replace(/[^\w-]/g, "")}`;
  const root = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLElement>(null);
  const sheets = { long: useRef<HTMLElement>(null), knowledge: useRef<HTMLElement>(null), muscle: useRef<HTMLElement>(null) };
  const played = useRef<Partial<Record<Kind, Animation[]>>>({});
  const mist = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const panels = { long: useRef<HTMLButtonElement>(null), knowledge: useRef<HTMLButtonElement>(null), muscle: useRef<HTMLButtonElement>(null) };
  // a viewport under the threshold is always stacked, so a phone never lays out the wide map first
  const [stacked, setStacked] = useState(() => typeof window !== "undefined" && window.innerWidth < STACK_BELOW);
  const [open, setOpen] = useState<Kind | null>(null);
  const [leaving, setLeaving] = useState<Kind[]>([]);
  const [mistOn, setMistOn] = useState(false);
  const [still, setStill] = useState(false);
  // labels and counts, then icons and glow, then Live; an open editor shows at once
  const stage = useStage(2, editing);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const before = useRef<string | null>(null);
  const quiet = useRef(false);
  const map = useMemo(() => memoryMap(text, bot.messages), [text, bot.messages]);
  const day = new Intl.DateTimeFormat(localeTag(locale), { month: "short", day: "numeric" });
  const task = currentTask(bot);
  const done = task?.plan.filter((step) => step.status === "done").length ?? 0;
  const total = task?.plan.length ?? 0, bars = Math.min(total, 12);
  const lit = done === total ? bars : done && Math.min(bars - 1, Math.max(1, Math.round((done / total) * bars)));
  const now = done < total && task?.plan.some((step) => step.status === "active") ? lit : -1;
  const biggest = Math.max(1, ...topics.map((each) => each.bytes));

  // the GPU probe makes a WebGL context, so it waits until the wide open has played
  useEffect(() => {
    const probe = setTimeout(() => setStill(softwareRender()), 600);
    return () => clearTimeout(probe);
  }, []);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = () => {
      const next = el.offsetWidth < STACK_BELOW;
      setStacked(next);
      onStack?.(next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const parts = (kind: Kind): OpenParts | null => {
    const card = panels[kind].current, to = sheets[kind].current;
    if (!card || !to) return null;
    const content = [...to.querySelectorAll<HTMLElement>("[data-mm-content]")];
    const { side } = KINDS[kind];
    const from = side === "bottom" ? card.offsetHeight / to.offsetHeight : card.offsetWidth / to.offsetWidth;
    return { sheet: to, content, mist: to.querySelector(".mm-mist"), specks: to.querySelector(".mm-specks"), from, side };
  };

  const fade = (to = sheet.current) => (to ? fadePanel({ sheet: to, content: [...to.querySelectorAll<HTMLElement>("[data-mm-content]")] }) : []);

  useLayoutEffect(() => {
    // the phone layout unmounts the sheets, so motion kept for them would play on detached nodes
    if (stacked) played.current = {};
    if (!open || stacked) return;
    const running = played.current[open];
    if (running) void playOpen(running, true);
    else if (quiet.current) played.current[open] = fade(sheets[open].current);
    else { const from = parts(open); if (from) played.current[open] = openPanel(from); }
    quiet.current = false;
    if (running) return;
    closeButton.current?.focus({ preventScroll: true });
    // scrolled inside the sheet only: scrollIntoView would move the whole tab too
    const body = sheets[open].current?.querySelector<HTMLElement>(".mm-sheet-body");
    const row = body?.querySelector<HTMLElement>("[data-fresh]");
    if (body && row) body.scrollTop = row.offsetTop - body.offsetTop - body.clientHeight / 2;
  }, [open, stacked]);

  useLayoutEffect(() => {
    if (!open || !stacked) return;
    const slot = panels[open].current?.parentElement;
    const fold = slot?.querySelector<HTMLElement>("[data-fold]");
    if (!slot || !fold || !root.current) return;
    const slots = [...root.current.querySelectorAll<HTMLElement>(".mm-slot")];
    const after: HTMLElement[] = [];
    for (let next = root.current.nextElementSibling; next instanceof HTMLElement; next = next.nextElementSibling) after.push(next);
    openFold(fold, [...slots.slice(slots.indexOf(slot) + 1), ...after], mist.current);
  }, [open, stacked]);

  const editingHere = editing && !stacked;
  useLayoutEffect(() => {
    if (editingHere) {
      before.current = text;
      setOpen(null);
      setLeaving([]);
      played.current = {};
      root.current?.closest(".overflow-y-auto")?.scrollTo({ top: 0 });
      fade();
      sheet.current?.querySelector("textarea")?.focus({ preventScroll: true });
      return;
    }
    if (before.current === null) return;
    // the dated view shows what the edit changed
    const was = new Set(before.current.split("\n").map((line) => line.trimEnd()));
    before.current = null;
    const changed = new Set(text.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim() && !was.has(line)));
    setFresh(changed);
    // a change that landed in Just Learned or Muscle Memory shows on the map itself
    if (stacked || !map.longTerm.some((each) => changed.has(each.line))) return;
    quiet.current = true;
    setMistOn(false);
    setOpen("long");
  }, [editingHere]);

  const close = (next: Kind | null = null) => {
    if (!open) return;
    const kind = open;
    setOpen(next);
    if (stacked) return;
    setLeaving((was) => [...was.filter((each) => each !== kind), kind]);
    void playOpen(played.current[kind] ?? [], false).then((done) => {
      if (!done) return;
      delete played.current[kind];
      setLeaving((was) => was.filter((each) => each !== kind));
      if (!next) panels[kind].current?.focus({ preventScroll: true });
    });
  };

  // another card, or the one now closing, opens from where its motion is
  const toggle = (kind: Kind) => {
    if (open === kind) { close(); return; }
    setLeaving((was) => was.filter((each) => each !== kind));
    if (!played.current[kind]) setMistOn(openMist());
    if (open) close(kind);
    else setOpen(kind);
  };

  const outside = ({ target }: { target: EventTarget }) => {
    if (open && !stacked && !(target as Element).closest(".mm-sheet, button.mm-panel")) close();
  };

  useEffect(() => {
    if (!(open || editingHere) || stacked) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (editingHere) onEditing?.(false);
      else close();
    };
    // capture, so Bot details' own Escape sees it handled and stays open
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  useEffect(() => { if (!active) { setOpen(null); setLeaving([]); played.current = {}; setFresh(new Set()); } }, [active]);

  const panel = (kind: Kind, icon: ReactNode, name: string, hint: string, count: number | null, foot: ReactNode, viz: ReactNode, list: ReactNode) => (
    <div className={cn("mm-slot", KINDS[kind].slot)}>
      <button ref={panels[kind]} type="button" aria-expanded={open === kind} disabled={failed} className="mm-panel" data-kind={kind} onClick={() => toggle(kind)}>
        <span className="mm-panel-top">
          <span className="mm-icon">{stage > 0 && icon}</span>
          {stage > 0 && (stacked
            ? <ChevronDown size={16} aria-hidden="true" className={cn("mm-chev transition-transform motion-reduce:transition-none", open === kind && "rotate-180")} />
            : <ChevronRight size={16} aria-hidden="true" className="mm-chev" />)}
        </span>
        <span className="mm-label">
          <span className="mm-name">{name}</span>
          <span className="mm-hint">{hint}</span>
        </span>
        {!stacked && stage > 0 && viz}
        <span className="mm-newest">{foot}</span>
        <Count kind={kind} count={count} />
      </button>
      {stacked && (
        <Fold open={open === kind}>
          <div className="mm-fold">
            {mistOn && open === kind && <div ref={mist} className="mm-sweep" aria-hidden="true" />}
            {kind === "long" && onEditing && <button type="button" className="mm-action mm-fold-edit" onClick={() => onEditing(true)}><Pencil size={13} aria-hidden="true" />{t("bot.memoryEdit")}</button>}
            {list}
          </div>
        </Fold>
      )}
    </div>
  );

  const newest = (fact?: string) => (fact ? <><em>{t("bot.memoryNewest")}</em>{fact}</> : failed ? null : t("bot.memoryNone"));
  const count = (value: number) => (failed ? null : value);
  const longList = <FactList facts={map.longTerm} day={day} fresh={fresh} />;
  const topicList = <TopicRows botId={bot.id} topics={topics} />;
  const muscleList = map.muscle.length ? <FactList facts={map.muscle} day={day} fresh={fresh} /> : <div className="mm-empty">{t("bot.memoryNone")}</div>;
  const lists = { long: longList, knowledge: topicList, muscle: muscleList };
  const counts = { long: map.longTerm.length, knowledge: topics.length, muscle: map.muscle.length };
  const shown = editingHere ? "file" : stacked ? null : open;

  return (
    <div ref={root} className="mm" data-stacked={stacked || undefined} data-open={shown ?? undefined} data-aura={AURA} data-still={still || undefined} onClick={outside}>
      {stage > 0 && (
        <>
          <svg width="0" height="0" className="absolute" aria-hidden="true">
            <defs>
              <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#67e8f9" />
                <stop offset=".5" stopColor="#818cf8" />
                <stop offset="1" stopColor="#a78bfa" />
              </linearGradient>
            </defs>
          </svg>
          <div className="mm-glow" aria-hidden="true" />
          <div className="mm-ray" aria-hidden="true" />
        </>
      )}
      <header className="mm-core">
        <div className="mm-brain" aria-hidden="true">
          {stage > 0 && (
            <>
              <span className="mm-orbit mm-orbit-near" />
              <span className="mm-orbit mm-orbit-far" />
              <Brain size={28} strokeWidth={1.6} stroke={`url(#${gradient})`} />
            </>
          )}
        </div>
        {failed && (
          <div role="alert" className="mm-failed">
            {t("bot.memoryLoadFailed")}
            <button type="button" className="mm-retry" onClick={onRetry}>{t("bot.memoryRetry")}</button>
          </div>
        )}
        {sleep && !failed && <SleepLine sleep={sleep} />}
      </header>
      <div className="mm-grid">
        {panel("long", <Archive size={16} aria-hidden="true" />, t("bot.memoryLongTerm"), t("bot.memoryLongTermHint"), count(map.longTerm.length), newest(map.longTerm[0]?.fact),
          <span className="mm-dots" aria-hidden="true">
            {map.longTerm.slice(0, DOTS).map((each, index) => <i key={each.line} data-glow={index < 3 ? 3 : index < 10 ? 2 : each.at ? 1 : 0} />)}
          </span>, longList)}
        <section className="mm-live" style={stage < 2 && stacked ? { minHeight: liveHeight(bot, Math.min(map.learned.length, LEARNED_SHOWN)) } : undefined}>
          {stage > 1 && (
            <>
              <div className="mm-live-tag"><span className="mm-live-dot" />{t("bot.memoryLive")}</div>
              <div>
                <div className="mm-sec-head"><Activity size={16} aria-hidden="true" /><span className="mm-sec-name">{t("bot.memoryWorking")}</span><span className="mm-sec-hint">{t("bot.memoryWorkingHint")}</span></div>
                {task ? (
                  <div className="mm-task">
                    <div className="mm-task-goal" title={task.goal}>{task.goal}</div>
                    {task.plan.length > 0 && (
                      <>
                        <div className="mm-steps" aria-hidden="true">{Array.from({ length: bars }, (_, index) => <i key={index} data-done={index < lit || undefined} data-now={index === now || undefined} />)}</div>
                        <div className="mm-task-meta">{t("bot.memoryTaskSteps", { done, total: task.plan.length })}</div>
                      </>
                    )}
                    {task.nextAction.trim() && <div className="mm-task-next">{t("bot.memoryTaskNext", { action: task.nextAction })}</div>}
                  </div>
                ) : <div className="mm-empty">{t("bot.memoryWorkingIdle")}</div>}
              </div>
              <div className="mm-learned">
                <div className="mm-sec-head"><Sparkle size={16} aria-hidden="true" /><span className="mm-sec-name">{t("bot.memoryLearned")}</span><span className="mm-sec-hint">{t("bot.memoryLearnedHint")}</span></div>
                {failed ? null : map.learned.length
                  ? <NotedLines text={text} messages={bot.messages} target={target} botId={bot.id} active={active} limit={LEARNED_SHOWN} />
                  : <div className="mm-empty">{t("bot.memoryNone")}</div>}
              </div>
            </>
          )}
        </section>
        {panel("knowledge", <BookOpen size={16} aria-hidden="true" />, t("bot.memoryKnowledge"), t("bot.memoryKnowledgeHint"), count(topics.length), topics.length ? topics.map((each) => each.name.replace(/\.md$/, "")).join(" · ") : newest(),
          <span className="mm-bars" aria-hidden="true">
            {topics.slice(0, 12).map((each) => <i key={each.name} style={{ height: `${Math.max(14, Math.round((each.bytes / biggest) * 100))}%` }} />)}
          </span>, topicList)}
        {panel("muscle", <Repeat size={16} aria-hidden="true" />, t("bot.memoryMuscle"), t("bot.memoryMuscleHint"), count(map.muscle.length), newest(map.muscle[0]?.fact), null, muscleList)}
        {shown === "file" && (
          <section ref={sheet} className="mm-sheet" data-kind="file" aria-label={t("bot.memoryFile")}>
            <div className="mm-sheet-head" data-mm-content="">
              <span className="mm-icon"><FileText size={16} aria-hidden="true" /></span>
              <span className="mm-label">
                <span className="mm-name">{t("bot.memoryFile")}</span>
                <span className="mm-hint">{t("bot.memoryThisBotHelp")}</span>
              </span>
              {saveState}
              <button type="button" className="mm-action" onClick={() => onEditing?.(false)}>{t("bot.memoryEditDone")}</button>
            </div>
            <div className="mm-sheet-body mm-edit" data-mm-content="">{editor}</div>
          </section>
        )}
        {!stacked && !editingHere && (Object.keys(KINDS) as Kind[]).filter((kind) => kind === open || leaving.includes(kind)).map((kind) => { const { icon: Icon, name, hint } = KINDS[kind]; return (
          <section key={kind} ref={sheets[kind]} className="mm-sheet" data-kind={kind} data-leaving={kind !== open || undefined} inert={kind !== open} aria-label={t(name)}>
            <div className="mm-sheet-head" data-mm-content="">
              <span className="mm-icon"><Icon size={16} aria-hidden="true" /></span>
              <span className="mm-label">
                <span className="mm-name">{t(name)}</span>
                <span className="mm-hint">{t(hint)}</span>
              </span>
              <Count kind={kind} count={counts[kind]} />
              {kind === "long" && onEditing && (
                <button type="button" className="mm-action" onClick={() => onEditing(true)}><Pencil size={13} aria-hidden="true" />{t("bot.memoryEdit")}</button>
              )}
              <button ref={kind === open ? closeButton : undefined} type="button" className="mm-close" onClick={() => close()} aria-label={t("bot.memoryClosePanel", { name: t(name) })}>
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <div className="mm-sheet-body" data-mm-content="">{lists[kind]}</div>
            {mistOn && (
              <>
                <div className="mm-mist" aria-hidden="true" />
                <div className="mm-specks" aria-hidden="true">
                  {SPECKS.map((each, index) => <i key={index} style={{ left: each.left, top: each.top, opacity: each.opacity, transform: `scale(${each.scale})` }} />)}
                </div>
              </>
            )}
          </section>
        ); })}
      </div>
    </div>
  );
}
