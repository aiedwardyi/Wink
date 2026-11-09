import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Maximize2, Minimize2, Play, X } from "lucide-react";
import { VERIFY_ROUTES, type VerifyCardData } from "../../shared/live-verify";
import { VERIFY_DOC_KINDS, type VerifyDocFinding, type VerifyDocKind } from "../../shared/verify-doc";
import { useI18n } from "@/lib/i18n";
import { reducedMotion } from "@/lib/phone-swipe";
import { useIsPhone } from "@/lib/use-phone-swipe";
import { readReplay, type VerifyReplayMark } from "@/lib/verify-replay";
import { verifyLiveGate } from "@/lib/verify-watch";
import { DOC_ROLE, docCopy } from "./VerifyDocCard";
import "./VerifyWatch.css";

const copy = {
  en: { live: "Live", expired: "Replay expired", failed: "Could not load the check", loading: "Opening the document", close: "Close", maximize: "Maximize", restore: "Restore", again: "Watch again", watch: "Watch the check", page: (n: number) => `p.${n}` },
  ko: { live: "실시간", expired: "다시보기가 만료됐어요", failed: "확인 과정을 불러오지 못했어요", loading: "문서를 여는 중", close: "닫기", maximize: "크게 보기", restore: "원래 크기", again: "다시 보기", watch: "확인 과정 보기", page: (n: number) => `${n}쪽` },
};
// A replay plays in about this long, however long the check took.
const PLAY_MS = 8_000;
const KINDS = new Set<string>(VERIFY_DOC_KINDS);
const route = (path: string, runId: string) => path.replace(":runId", encodeURIComponent(runId));
const int = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

interface Band { from: number; to: number; done: boolean }
interface Show { lines: string[] | null; starts: number[]; bands: Band[]; findings: VerifyDocFinding[]; ms: number; ended: boolean; blocked?: boolean }
const EMPTY: Show = { lines: null, starts: [0], bands: [], findings: [], ms: 0, ended: false };

function apply(show: Show, mark: VerifyReplayMark): Show {
  if (mark.kind === "doc-text" && Array.isArray(mark.lines)) {
    const lines = mark.lines.map(line => typeof line === "string" ? line : "");
    const starts = Array.isArray(mark.pageStarts) ? mark.pageStarts.filter((n): n is number => int(n) && n > 0 && n < lines.length) : [];
    return { ...show, lines, starts: [0, ...starts], ms: mark.ms };
  }
  if (mark.kind === "doc-chunk" && int(mark.from) && int(mark.to)) {
    const band = { from: mark.from, to: mark.to, done: mark.state === "done" };
    return { ...show, bands: [...show.bands.filter(row => row.from !== band.from), band], ms: mark.ms };
  }
  const f = mark.kind === "doc-finding" && mark.finding && typeof mark.finding === "object" ? mark.finding as Record<string, unknown> : null;
  if (!f || !KINDS.has(String(f.kind)) || !int(f.line) || !int(f.page) || typeof f.quote !== "string") return show;
  const finding: VerifyDocFinding = { kind: f.kind as VerifyDocKind, line: f.line, page: f.page, quote: f.quote, fix: typeof f.fix === "string" ? f.fix : "" };
  if (typeof f.note === "string") finding.note = f.note;
  return { ...show, findings: [...show.findings, finding], ms: mark.ms };
}

function marked(line: string, hits: VerifyDocFinding[] | undefined): ReactNode {
  if (!hits) return line || " ";
  const parts: ReactNode[] = [];
  let at = 0;
  for (const { f, i } of hits.map(f => ({ f, i: f.quote ? line.indexOf(f.quote) : -1 })).filter(spot => spot.i >= 0).sort((a, b) => a.i - b.i)) {
    if (i < at) continue;
    parts.push(line.slice(at, i), <mark key={i} title={f.fix ? `→ ${f.fix}` : f.note}>{f.quote}</mark>);
    at = i + f.quote.length;
  }
  parts.push(line.slice(at) || (at ? "" : " "));
  return parts;
}

interface SheetProps { lines: string[]; start: number; end: number; label: string; bands: Band[]; findings: VerifyDocFinding[]; sig: string }
const Sheet = memo(function Sheet({ lines, start, end, label, bands, findings }: SheetProps) {
  const hits = new Map<number, VerifyDocFinding[]>();
  for (const f of findings) hits.set(f.line, [...hits.get(f.line) ?? [], f]);
  const rows: ReactNode[] = [];
  for (let i = start; i < end; i++) {
    const n = i + 1, band = bands.findLast(row => n >= row.from && n <= row.to);
    rows.push(<div key={n} className="verify-doc-line" data-n={n} data-on={band && !band.done || undefined} data-hit={hits.has(n) || undefined}>{marked(lines[i]!, hits.get(n))}</div>);
  }
  return <div className="verify-doc-sheet"><span className="verify-doc-page">{label}</span>{rows}</div>;
}, (a, b) => a.sig === b.sig && a.lines === b.lines && a.label === b.label);

function useVisibility() {
  const [visibility, setVisibility] = useState(() => document.visibilityState);
  useEffect(() => {
    const flip = () => setVisibility(document.visibilityState);
    document.addEventListener("visibilitychange", flip);
    return () => document.removeEventListener("visibilitychange", flip);
  }, []);
  return visibility;
}

export function VerifyDocWatchFrame({ card, live, hidden, closing = false, inline = false, onClose }: { card: VerifyCardData; threadId: string; live: boolean; hidden: boolean; closing?: boolean; inline?: boolean; onClose(): void }) {
  const { locale } = useI18n();
  const c = copy[locale], d = docCopy[locale];
  const phone = useIsPhone();
  const gate = verifyLiveGate(!closing, hidden, useVisibility());
  const [show, setShow] = useState(EMPTY);
  const [phase, setPhase] = useState<"loading" | "play" | "done" | "failed" | "expired">("loading");
  const [round, setRound] = useState(0);
  const [maximized, setMaximized] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const expanded = maximized && !inline && !phone;
  const stageRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const close = useRef(onClose);
  close.current = onClose;
  const runId = live ? card.runId : card.replay?.at(-1);
  const streaming = live ? gate : true;

  useEffect(() => {
    if (!streaming) return;
    if (!runId) { setPhase("expired"); return; }
    const abort = new AbortController();
    setShow(EMPTY); setPhase("loading"); follow.current = true;
    void (async () => {
      const res = await fetch(route(live ? VERIFY_ROUTES.live : VERIFY_ROUTES.replay, runId), { cache: "no-store", signal: abort.signal });
      if (res.status === 404) { setPhase("expired"); return; }
      if (!res.ok || !res.body) { setPhase("failed"); return; }
      if (live) {
        setPhase("play");
        let total = 0, blocked = false;
        for await (const chunk of readReplay(res.body)) {
          if (chunk.kind === "mark") setShow(show => apply(show, chunk.mark));
          else if (chunk.kind === "end") { total = chunk.end.ms; blocked = chunk.end.status !== "completed"; }
        }
        setShow(show => ({ ...show, ms: Math.max(show.ms, total), ended: true, blocked }));
        setPhase("done");
        return;
      }
      const marks: VerifyReplayMark[] = [];
      let total = 0, blocked = false;
      for await (const chunk of readReplay(res.body)) {
        if (chunk.kind === "mark") marks.push(chunk.mark);
        else if (chunk.kind === "end") { total = chunk.end.ms; blocked = chunk.end.status !== "completed"; }
      }
      const speed = Math.max(1, Math.max(total, marks.at(-1)?.ms ?? 0) / PLAY_MS), began = performance.now();
      setPhase("play");
      for (let i = 0; i < marks.length && !abort.signal.aborted;) {
        const due: VerifyReplayMark[] = [];
        while (i < marks.length && marks[i]!.ms <= (performance.now() - began) * speed) due.push(marks[i++]!);
        if (due.length) setShow(show => due.reduce(apply, show));
        await new Promise(done => setTimeout(done, 100));
      }
      if (abort.signal.aborted) return;
      setShow(show => ({ ...show, ms: Math.max(show.ms, total), ended: true, blocked }));
      setPhase("done");
    })().catch(() => { if (!abort.signal.aborted) setPhase("failed"); });
    return () => abort.abort();
  }, [live, round, runId, streaming]);

  useEffect(() => {
    if (!live || phase !== "play" || !gate) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [gate, live, phase]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (expanded) { event.preventDefault(); setMaximized(false); }
      else close.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  const lead = show.bands.findLast(band => !band.done);
  const target = lead?.from ?? (show.ended ? show.findings[0]?.line : undefined);
  useEffect(() => {
    const stage = stageRef.current, row = target === undefined ? null : stage?.querySelector<HTMLElement>(`[data-n="${target}"]`);
    if (!stage || !row || !follow.current) return;
    stage.scrollTo({ top: Math.max(0, row.getBoundingClientRect().top - stage.getBoundingClientRect().top + stage.scrollTop - stage.clientHeight / 3), behavior: reducedMotion() ? "auto" : "smooth" });
  }, [target, show.lines]);

  const pages = useMemo(() => {
    const lines = show.lines;
    return lines ? show.starts.map((start, i) => ({ start, end: show.starts[i + 1] ?? lines.length })) : [];
  }, [show.lines, show.starts]);
  const pageOf = (line: number) => Math.max(1, pages.findLastIndex(page => page.start < line) + 1);
  const counts = new Map<VerifyDocKind, number>();
  for (const f of show.findings) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  const status = phase === "expired" ? c.expired : phase === "failed" ? c.failed
    : show.ended ? show.blocked ? d.failed : show.findings.length ? d.problems(show.findings.length) : d.clean
    : lead ? d.checking(pageOf(lead.from), pages.length) : show.bands.length ? d.comparing : c.loading;
  const seconds = Math.round((live && phase === "play" && card.startedAt ? now - card.startedAt : show.ms) / 1000);
  const stop = () => { follow.current = false; };

  return (
    <div className="verify-watch-frame verify-doc-watch" data-inline={inline || undefined} data-maximized={expanded || undefined}>
      <div className="verify-watch-bar">
        <span className="verify-watch-dots" aria-hidden="true"><i /><i /><i /></span>
        <span className="verify-watch-grow" />
        {!inline && !phone && <button type="button" className="verify-watch-icon" onClick={() => setMaximized(!maximized)} aria-label={expanded ? c.restore : c.maximize} title={expanded ? c.restore : c.maximize}>{expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>}
        <button type="button" className="verify-watch-icon" onClick={() => close.current()} aria-label={c.close} title={c.close}><X size={15} /></button>
      </div>
      <div className="verify-watch-address"><span className="verify-watch-url" title={card.entry}>{card.site}</span></div>
      <div ref={stageRef} className="verify-doc-stage" aria-label={c.watch} onWheel={stop} onTouchMove={stop}>
        {show.lines ? pages.map((page, i) => {
          const bands = show.bands.filter(band => band.from <= page.end && band.to > page.start);
          const findings = show.findings.filter(f => f.line > page.start && f.line <= page.end);
          return <Sheet key={i} lines={show.lines!} start={page.start} end={page.end} label={c.page(i + 1)} bands={bands} findings={findings} sig={`${bands.map(band => `${band.from}-${band.to}${band.done ? "d" : ""}`).join()}|${findings.length}`} />;
        }) : <div className="verify-doc-wait">{phase === "loading" || phase === "play" ? c.loading : status}</div>}
      </div>
      <div className="verify-watch-line">
        {live && phase === "play" && <span className="verify-watch-live">{c.live}</span>}
        <span data-current>{status}</span>
        <span className="verify-watch-seconds">{seconds}{d.s}</span>
      </div>
      <ul className="verify-doc-tally">{VERIFY_DOC_KINDS.map(kind => (
        <li key={kind} style={{ "--role": DOC_ROLE[kind] } as CSSProperties}><i /><span>{d.kinds[kind]}</span><b data-issues={counts.get(kind) ? true : undefined}>{counts.get(kind) ?? 0}</b></li>
      ))}</ul>
      {!live && (phase === "done" || phase === "failed") && <button type="button" className="verify-watch-again" onClick={() => setRound(round + 1)}><Play size={14} />{c.again}</button>}
    </div>
  );
}
