import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Activity, Archive, BookOpen, Brain, ChevronDown, ChevronRight, Moon, Repeat, Sparkle, Undo2, X } from "lucide-react";
import type { AppState, Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { localeTag, useI18n, type MessageKey } from "@/lib/i18n";
import { memoryMap, LEARNED_SHOWN, type MemoryFact } from "@/lib/memory-map";
import { currentTask, formatBytes, NotedLines, type MemoryTopic } from "./MemoryGroups";
import { closePanel, openMist, openPanel, type OpenParts } from "./MemoryMapMotion";
import { Fold } from "./Fold";
import "./MemoryMap.css";

export interface SleepReadout {
  sleptAt: Date;
  kept: number;
  merged: number;
  forgot: number;
  learned: number;
  onUndo: () => void;
}

type Kind = "long" | "knowledge";

// below this the three kinds stack, as on a phone
const STACK_BELOW = 860;
const DOTS = 40;

const UNITS = {
  long: ["bot.memoryFactsOne", "bot.memoryFacts"],
  knowledge: ["bot.memoryFilesOne", "bot.memoryFiles"],
  muscle: ["bot.memoryLessonsOne", "bot.memoryLessons"],
} satisfies Record<string, [MessageKey, MessageKey]>;

let seed = 7;
const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
const SPECKS = Array.from({ length: 26 }, () => ({ left: `${rnd() * 100}%`, top: `${rnd() * 100}%`, opacity: 0.35 + rnd() * 0.5, scale: 0.6 + rnd() }));

function Count({ kind, count }: { kind: keyof typeof UNITS; count: number }) {
  const { t } = useI18n();
  return (
    <span className="mm-count">
      <b>{count}</b>
      <span>{t(UNITS[kind][count === 1 ? 0 : 1])}</span>
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

function FactList({ facts, day }: { facts: MemoryFact[]; day: Intl.DateTimeFormat }) {
  return (
    <ul className="mm-list">
      {facts.map((each) => (
        <li key={each.line}>
          <span className="mm-list-text">{each.fact}</span>
          <span className="mm-date">{each.at ? day.format(each.at) : ""}</span>
        </li>
      ))}
    </ul>
  );
}

function TopicList({ topics }: { topics: MemoryTopic[] }) {
  return (
    <ul className="mm-list">
      {topics.map((each) => (
        <li key={each.name}>
          <span className="mm-list-text">{each.name}</span>
          <span className="mm-date">{formatBytes(each.bytes)}</span>
        </li>
      ))}
    </ul>
  );
}

export function MemoryMap({ bot, text, topics, target, active, sleep = null }: {
  bot: Bot;
  text: string;
  topics: MemoryTopic[];
  target?: AppState["settingsMemoryTarget"];
  active: boolean;
  sleep?: SleepReadout | null;
}) {
  const { t, locale } = useI18n();
  const gradient = `mm${useId().replace(/[^\w-]/g, "")}`;
  const root = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLElement>(null);
  const mist = useRef<HTMLDivElement>(null);
  const specks = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const panels = { long: useRef<HTMLButtonElement>(null), knowledge: useRef<HTMLButtonElement>(null) };
  const [stacked, setStacked] = useState(false);
  const [open, setOpen] = useState<Kind | null>(null);
  const [closing, setClosing] = useState(false);
  const [mistOn, setMistOn] = useState(false);
  const map = useMemo(() => memoryMap(text, bot.messages), [text, bot.messages]);
  const day = new Intl.DateTimeFormat(localeTag(locale), { month: "short", day: "numeric" });
  const task = currentTask(bot);
  const done = task?.plan.filter((step) => step.status === "done").length ?? 0;
  const biggest = Math.max(1, ...topics.map((each) => each.bytes));

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    setStacked(el.offsetWidth < STACK_BELOW);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setStacked(el.offsetWidth < STACK_BELOW));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const parts = (kind: Kind): OpenParts | null => {
    const from = panels[kind].current, to = sheet.current;
    if (!from || !to) return null;
    const content = [...to.querySelectorAll<HTMLElement>("[data-mm-content]")];
    return { sheet: to, content, mist: mist.current, specks: specks.current, from: from.offsetWidth / to.offsetWidth, side: kind === "long" ? "left" : "right" };
  };

  useLayoutEffect(() => {
    if (!open || stacked || closing) return;
    const each = parts(open);
    if (each) openPanel(each);
    closeButton.current?.focus({ preventScroll: true });
  }, [open, stacked]);

  const close = () => {
    if (!open || closing) return;
    const kind = open;
    if (stacked) { setOpen(null); return; }
    const each = parts(kind);
    setClosing(true);
    void (each ? closePanel(each) : Promise.resolve()).then(() => {
      setOpen(null);
      setClosing(false);
      panels[kind].current?.focus({ preventScroll: true });
    });
  };

  const toggle = (kind: Kind) => {
    if (open === kind) { close(); return; }
    if (open && !stacked) return;
    setMistOn(openMist());
    setOpen(kind);
  };

  useEffect(() => {
    if (!open || stacked) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
    };
    // capture, so Bot details' own Escape sees it handled and stays open
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  useEffect(() => { if (!active) { setOpen(null); setClosing(false); } }, [active]);

  const panel = (kind: Kind, icon: ReactNode, name: string, hint: string, count: number, foot: ReactNode, viz: ReactNode, list: ReactNode) => (
    <div className={cn("mm-slot", kind === "long" ? "mm-left" : "mm-right")}>
      <button ref={panels[kind]} type="button" aria-expanded={open === kind} className="mm-panel" data-kind={kind} onClick={() => toggle(kind)}>
        <span className="mm-panel-top">
          <span className="mm-icon">{icon}</span>
          {stacked
            ? <ChevronDown size={16} aria-hidden="true" className={cn("mm-chev transition-transform motion-reduce:transition-none", open === kind && "rotate-180")} />
            : <ChevronRight size={16} aria-hidden="true" className="mm-chev" />}
        </span>
        <span className="mm-label">
          <span className="mm-name">{name}</span>
          <span className="mm-hint">{hint}</span>
        </span>
        {viz}
        <span className="mm-newest">{foot}</span>
        <Count kind={kind} count={count} />
      </button>
      {stacked && <Fold open={open === kind}><div className="mm-fold">{list}</div></Fold>}
    </div>
  );

  const newest = (fact?: string) => (fact ? <><em>{t("bot.memoryNewest")}</em>{fact}</> : t("bot.memoryNone"));
  const longList = <FactList facts={map.longTerm} day={day} />;
  const topicList = <TopicList topics={topics} />;
  const shown = open && !stacked;

  return (
    <div ref={root} className="mm" data-stacked={stacked || undefined} data-open={shown ? open : undefined} data-closing={closing || undefined}>
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
      <header className="mm-core">
        <div className="mm-brain" aria-hidden="true">
          <span className="mm-orbit mm-orbit-near" />
          <span className="mm-orbit mm-orbit-far" />
          <Brain size={28} strokeWidth={1.6} stroke={`url(#${gradient})`} />
        </div>
        {sleep && <SleepLine sleep={sleep} />}
      </header>
      <div className="mm-grid">
        {panel("long", <Archive size={16} aria-hidden="true" />, t("bot.memoryLongTerm"), t("bot.memoryLongTermHint"), map.longTerm.length, newest(map.longTerm[0]?.fact),
          <span className="mm-dots" aria-hidden="true">
            {map.longTerm.slice(0, DOTS).map((each, index) => <i key={each.line} data-glow={index < 3 ? 3 : index < 10 ? 2 : each.at ? 1 : 0} />)}
          </span>, longList)}
        <section className="mm-live">
          <div className="mm-live-tag"><span className="mm-live-dot" />{t("bot.memoryLive")}</div>
          <div>
            <div className="mm-sec-head"><Activity size={16} aria-hidden="true" /><span className="mm-sec-name">{t("bot.memoryWorking")}</span><span className="mm-sec-hint">{t("bot.memoryWorkingHint")}</span></div>
            {task ? (
              <div className="mm-task">
                <div className="mm-task-goal" title={task.goal}>{task.goal}</div>
                {task.plan.length > 0 && (
                  <>
                    <div className="mm-steps" aria-hidden="true">{task.plan.slice(0, 12).map((step, index) => <i key={index} data-done={step.status === "done" || undefined} />)}</div>
                    <div className="mm-task-meta">{t("bot.memoryTaskSteps", { done, total: task.plan.length })}</div>
                  </>
                )}
                {task.nextAction.trim() && <div className="mm-task-next">{t("bot.memoryTaskNext", { action: task.nextAction })}</div>}
              </div>
            ) : <div className="mm-empty">{t("bot.memoryWorkingIdle")}</div>}
          </div>
          <div className="mm-learned">
            <div className="mm-sec-head"><Sparkle size={16} aria-hidden="true" /><span className="mm-sec-name">{t("bot.memoryLearned")}</span><span className="mm-sec-hint">{t("bot.memoryLearnedHint")}</span></div>
            {map.learned.length
              ? <NotedLines text={text} messages={bot.messages} target={target} botId={bot.id} active={active} limit={LEARNED_SHOWN} />
              : <div className="mm-empty">{t("bot.memoryNone")}</div>}
          </div>
        </section>
        {panel("knowledge", <BookOpen size={16} aria-hidden="true" />, t("bot.memoryKnowledge"), t("bot.memoryKnowledgeHint"), topics.length, topics.length ? topics.map((each) => each.name.replace(/\.md$/, "")).join(" · ") : t("bot.memoryNone"),
          <span className="mm-bars" aria-hidden="true">
            {topics.slice(0, 12).map((each) => <i key={each.name} style={{ height: `${Math.max(14, Math.round((each.bytes / biggest) * 100))}%` }} />)}
          </span>, topicList)}
        <div className="mm-slot mm-bottom">
          <div className="mm-panel" data-kind="muscle">
            <span className="mm-icon"><Repeat size={16} aria-hidden="true" /></span>
            <span className="mm-label">
              <span className="mm-name">{t("bot.memoryMuscle")}</span>
              <span className="mm-hint">{t("bot.memoryMuscleHint")}</span>
            </span>
            <span className="mm-newest">{newest(map.muscle[0]?.fact)}</span>
            <Count kind="muscle" count={map.muscle.length} />
          </div>
        </div>
        {shown && (
          <section ref={sheet} className="mm-sheet" data-kind={open} aria-label={open === "long" ? t("bot.memoryLongTerm") : t("bot.memoryKnowledge")}>
            <div className="mm-sheet-head" data-mm-content="">
              <span className="mm-icon">{open === "long" ? <Archive size={16} aria-hidden="true" /> : <BookOpen size={16} aria-hidden="true" />}</span>
              <span className="mm-label">
                <span className="mm-name">{open === "long" ? t("bot.memoryLongTerm") : t("bot.memoryKnowledge")}</span>
                <span className="mm-hint">{open === "long" ? t("bot.memoryLongTermHint") : t("bot.memoryKnowledgeHint")}</span>
              </span>
              <Count kind={open} count={open === "long" ? map.longTerm.length : topics.length} />
              <button ref={closeButton} type="button" className="mm-close" onClick={close} aria-label={t("bot.memoryClosePanel", { name: open === "long" ? t("bot.memoryLongTerm") : t("bot.memoryKnowledge") })}>
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <div className="mm-sheet-body" data-mm-content="">{open === "long" ? longList : topicList}</div>
            {mistOn && (
              <>
                <div ref={mist} className="mm-mist" aria-hidden="true" />
                <div ref={specks} className="mm-specks" aria-hidden="true">
                  {SPECKS.map((each, index) => <i key={index} style={{ left: each.left, top: each.top, opacity: each.opacity, transform: `scale(${each.scale})` }} />)}
                </div>
              </>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
