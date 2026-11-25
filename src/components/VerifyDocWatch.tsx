import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { Maximize2, Minimize2, Play, X } from "lucide-react";
import { VERIFY_ROUTES, type VerifyCardData } from "../../shared/live-verify";
import { VERIFY_DOC_KINDS, type VerifyDocFinding, type VerifyDocKind } from "../../shared/verify-doc";
import { useI18n } from "@/lib/i18n";
import { reducedMotion } from "@/lib/phone-swipe";
import { useIsPhone } from "@/lib/use-phone-swipe";
import { docCamera, type DocView } from "@/lib/verify-doc-camera";
import { docCols, VerifyDocShow, type DocCursor } from "@/lib/verify-doc-show";
import { readReplay, type VerifyReplayMark } from "@/lib/verify-replay";
import { verifyLiveGate } from "@/lib/verify-watch";
import { CURSOR_ARROW, glideEase, tagSpot } from "@/lib/verify-watch-show";
import { DOC_ROLE, docCopy } from "./VerifyDocCard";
import "./VerifyWatch.css";

const copy = {
  en: { live: "Live", expired: "Replay expired", unavailable: "Replay unavailable on this PC", failed: "Could not load the check", loading: "Opening the document", close: "Close", maximize: "Maximize", restore: "Restore", again: "Watch again", watch: "Watch the check", page: (n: number) => `p.${n}` },
  ko: { live: "실시간", expired: "다시보기가 만료됐어요", unavailable: "이 PC에서 다시보기를 사용할 수 없어요", failed: "확인 과정을 불러오지 못했어요", loading: "문서를 여는 중", close: "닫기", maximize: "크게 보기", restore: "원래 크기", again: "다시 보기", watch: "확인 과정 보기", page: (n: number) => `${n}쪽` },
};
const FADE_MS = 180;
const EASE = Array.from({ length: 9 }, (_, i) => glideEase(i / 8));
const RIDE = [0, 1];
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
    return { ...show, lines, starts: [0, ...starts], ms: Math.max(show.ms, mark.ms) };
  }
  if (mark.kind === "doc-chunk" && int(mark.from) && int(mark.to)) {
    const band = { from: mark.from, to: mark.to, done: mark.state === "done" };
    return { ...show, bands: [...show.bands.filter(row => row.from !== band.from), band], ms: Math.max(show.ms, mark.ms) };
  }
  const f = mark.kind === "doc-finding" && mark.finding && typeof mark.finding === "object" ? mark.finding as Record<string, unknown> : null;
  if (!f || !KINDS.has(String(f.kind)) || !int(f.line) || !int(f.page) || typeof f.quote !== "string") return show;
  const finding: VerifyDocFinding = { kind: f.kind as VerifyDocKind, line: f.line, page: f.page, quote: f.quote, fix: typeof f.fix === "string" ? f.fix : "" };
  if (typeof f.note === "string") finding.note = f.note;
  return { ...show, findings: [...show.findings, finding], ms: Math.max(show.ms, mark.ms) };
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

function linesInView(stage: HTMLElement): [number, number] | null {
  const { top, bottom } = stage.getBoundingClientRect();
  const seen = (el: Element) => { const box = el.getBoundingClientRect(); return box.bottom > top && box.top < bottom; };
  const rows = [...stage.querySelectorAll(".verify-doc-sheet")].filter(seen).flatMap(sheet => [...sheet.querySelectorAll<HTMLElement>(".verify-doc-line")].filter(seen));
  // A row cut by an edge would put the names cursor off screen.
  const whole = rows.filter(row => { const box = row.getBoundingClientRect(); return box.top >= top && box.bottom <= bottom; }), shown = whole.length ? whole : rows;
  return shown.length ? [Number(shown[0]!.dataset.n), Number(shown.at(-1)!.dataset.n)] : null;
}

/** Columns one drawn row of the sheet holds. */
function perRow(stage: HTMLElement, lines: unknown): number {
  const line = stage.querySelector<HTMLElement>(".verify-doc-line"), ctx = document.createElement("canvas").getContext?.("2d"), sample = Array.isArray(lines) ? lines.join(" ").slice(0, 2_000) : "";
  if (!line || !ctx || !sample.trim()) return Infinity;
  const style = getComputedStyle(line), width = line.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
  ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const col = ctx.measureText(sample).width / docCols(sample);
  return width > 0 && col > 0 ? width / col : Infinity;
}

/** The checkers' cursors: plain elements moved by transform, outside React, so a glide costs no render. `leading`: the first line of the chunk the view reads, none when it no longer follows. `glide`: a camera moves the view. */
function docCursors(stage: HTMLElement, tag: (kind: VerifyDocKind) => string, leading: () => number | undefined, glide: boolean, front: (now: number) => number | null, wrap: Pick<VerifyDocShow, "row" | "lineAt">) {
  // Numbering skims for the rules without the view; it leads only on its way to a quote.
  const reads = (c: DocCursor) => c.kind !== "numbering" || c.quote !== undefined, follows = (c: DocCursor, band = leading()) => c.band === band && reads(c);
  const shown = new Map<string, { el: HTMLElement; x: number; y: number; from: number; fromX: number; at: number; ms: number; doc: DocCursor; find: boolean; curve: readonly number[]; animation?: Animation; rows?: { from: number; to: number; adj: number } }>(), fading = new Set<ReturnType<typeof setTimeout>>();
  let offset = 0, frame = 0;
  // Within the line's own box: the next line may start a sheet not laid out yet.
  const lineY = (line: number) => {
    const view = stage.getBoundingClientRect().top - stage.scrollTop, box = (n: number) => stage.querySelector<HTMLElement>(`[data-n="${n}"]`)?.getBoundingClientRect();
    // A front past the last line sits at its bottom.
    const own = box(Math.floor(line)), end = own || line % 1 ? undefined : box(line - 1);
    return own ? own.top + own.height * (line % 1) - view : end && end.bottom - view;
  };
  // A skim reader rides the same front the view sweeps with, a few rows below it; only its place among those rows glides.
  const ride = (now: number) => {
    frame = 0;
    const at = front(now);
    for (const c of shown.values()) {
      if (!c.rows || at === null) continue;
      const k = c.ms ? Math.min(1, Math.max(0, (now - c.at) / c.ms)) : 1, y = lineY(wrap.lineAt(wrap.row(at) + c.rows.from + (c.rows.to - c.rows.from) * k));
      if (y !== undefined) c.el.style.transform = `translate(${c.fromX + (c.x - c.fromX) * k}px,${y - offset + c.rows.adj}px)`;
    }
    if ([...shown.values()].some(c => c.rows)) frame = requestAnimationFrame(ride);
  };
  return {
    move(c: DocCursor) {
      const layer = stage.querySelector<HTMLElement>(".verify-doc-cursors"), row = stage.querySelector<HTMLElement>(`[data-n="${c.line}"]`);
      if (!layer || !row) return;
      const text = row.textContent ?? "", walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT), range = document.createRange();
      let at = c.quote ? Math.max(0, text.indexOf(c.quote)) : Math.round(c.along * (text.length - 1)), node = walker.nextNode() as Text | null;
      for (let next: Node | null; node && at >= node.length && (next = walker.nextNode()); node = next as Text) at -= node.length;
      if (node) {
        at = Math.max(0, Math.min(at, node.length - 1));
        range.setStart(node, at);
        range.setEnd(node, Math.min(node.length, at + 1));
      }
      const box = (node && range.getClientRects?.()[0]) ?? row.getBoundingClientRect(), origin = layer.getBoundingClientRect();
      const x = box.left - origin.left, y = box.top + box.height * 0.6 - origin.top, view = stage.getBoundingClientRect().top, top = box.top - view, lead = follows(c);
      offset = origin.top - view + stage.scrollTop;
      if (!glide && lead && (top < 0 || top > stage.clientHeight * 0.7)) stage.scrollTo({ top: stage.scrollTop + top - stage.clientHeight / 3, behavior: "smooth" });
      let cursor = shown.get(c.id);
      if (!cursor) {
        const el = document.createElement("div");
        el.className = "verify-watch-cursor";
        el.dataset.kind = c.kind;
        el.style.setProperty("--role", DOC_ROLE[c.kind]);
        el.innerHTML = `<svg viewBox="0 0 15 21" width="15" height="21"><path d="${CURSOR_ARROW}"/></svg><span></span>`;
        el.lastElementChild!.textContent = tag(c.kind);
        layer.append(el);
        el.animate?.([{ opacity: 0 }, { opacity: 1 }], FADE_MS);
        shown.set(c.id, cursor = { el, x, y, from: y, fromX: x, at: 0, ms: 0, doc: c, find: false, curve: EASE });
      }
      const { el, x: fx, y: fy } = cursor, label = el.lastElementChild as HTMLElement;
      const spot = tagSpot({}, { x, y }, label.offsetWidth, [row.parentElement!.getBoundingClientRect().right - origin.left, layer.clientHeight], 1)!;
      label.style.transform = `translate(${spot.x}px,${spot.y}px)`;
      el.dataset.line = String(c.line);
      el.style.transform = `translate(${x}px,${y}px)`;
      const curve = c.ride ? RIDE : EASE, animation = c.duration && !c.ride ? el.animate?.(EASE.map(e => ({ transform: `translate(${fx + (x - fx) * e}px,${fy + (y - fy) * e}px)` })), c.duration) : undefined;
      if (c.ride) cursor.animation?.cancel();
      // A rider keeps its rows below the front, so drawing that ran late here cannot leave it behind the view.
      const now = performance.now(), edge = c.ride ? front(now) : null, place = c.line + c.along, rowY = c.ride ? lineY(place) : undefined;
      const rows = edge === null || rowY === undefined || c.ahead === undefined ? undefined : { from: cursor.rows ? cursor.rows.from + (cursor.rows.to - cursor.rows.from) * Math.min(1, cursor.ms ? (now - cursor.at) / cursor.ms : 1) : wrap.row(place) - wrap.row(edge), to: c.ahead, adj: y - (rowY - offset) };
      Object.assign(cursor, { x, y, from: fy, fromX: fx, at: now, ms: c.duration, doc: c, find: c.quote !== undefined, curve, animation, rows });
      if (rows) {
        const at = front(now), start = at === null ? undefined : lineY(wrap.lineAt(wrap.row(at) + rows.from));
        if (start !== undefined) el.style.transform = `translate(${fx}px,${start - offset + rows.adj}px)`;
        if (!frame) frame = requestAnimationFrame(ride);
      }
    },
    /** The furthest-down reader of the chunk being read and the names cursor, in the stage's scroll space. */
    view(now: number): DocView {
      const seen: DocView = {}, top = stage.scrollTop, spots = [...shown.values()].map(c => {
        // A browser glide can start a frame later than the timer that requested it.
        const time = c.animation?.currentTime, elapsed = typeof time === "number" ? time : time === null ? 0 : now - c.at;
        const k = Math.min(1, Math.max(0, elapsed / Math.max(1, c.ms))) * (c.curve.length - 1), i = Math.min(c.curve.length - 2, Math.floor(k));
        const ease = c.curve[i]! + (c.curve[i + 1]! - c.curve[i]!) * (k - i);
        return { c, y: offset + c.from + (c.y - c.from) * ease, to: offset + c.y };
      });
      // Asked each frame, not when a cursor last moved: a chunk's readers start while the one above still lands its quotes, and lead once it closes.
      // The view never backs up, so once the leading chunk's readers have all gone above it for quotes, the next chunk down leads.
      let band = leading();
      if (band !== undefined && !spots.some(({ c, y, to }) => follows(c.doc, band) && Math.max(y, to) >= top)) {
        const below = spots.filter(({ c }) => c.doc.band > band! && reads(c.doc)).map(({ c }) => c.doc.band);
        if (below.length) band = Math.min(...below);
      }
      for (const { c, y, to } of spots) {
        const lead = follows(c.doc, band);
        if (c.doc.band === 0 && !(lead && c.find)) seen.stop = Math.min(seen.stop ?? Infinity, y);
        else if (lead) seen.lead = { y: Math.max(seen.lead?.y ?? -Infinity, y), to: Math.max(seen.lead?.to ?? -Infinity, to) };
      }
      return seen;
    },
    lineY,
    leave(id: string) {
      const cursor = shown.get(id);
      if (!cursor) return;
      shown.delete(id);
      cursor.el.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, fill: "forwards" });
      const gone = setTimeout(() => { fading.delete(gone); cursor.el.remove(); }, FADE_MS);
      fading.add(gone);
    },
    clear() {
      cancelAnimationFrame(frame);
      frame = 0;
      fading.forEach(clearTimeout);
      fading.clear();
      shown.clear();
      stage.querySelector(".verify-doc-cursors")?.replaceChildren();
    },
  };
}

function useVisibility() {
  const [visibility, setVisibility] = useState(() => document.visibilityState);
  useEffect(() => {
    const flip = () => setVisibility(document.visibilityState);
    document.addEventListener("visibilitychange", flip);
    return () => document.removeEventListener("visibilitychange", flip);
  }, []);
  return visibility;
}

export function VerifyDocWatchFrame({ card, live, hidden, closing = false, inline = false, hosted, onClose }: { card: VerifyCardData; threadId: string; live: boolean; hidden: boolean; closing?: boolean; inline?: boolean; hosted?: { maximized: boolean }; onClose(): void }) {
  const { locale } = useI18n();
  const c = copy[locale], d = docCopy[locale];
  const phone = useIsPhone();
  const gate = verifyLiveGate(!closing, hidden, useVisibility());
  const [show, setShow] = useState(EMPTY);
  const [phase, setPhase] = useState<"loading" | "play" | "done" | "failed" | "expired" | "unavailable">("loading");
  const [round, setRound] = useState(0);
  const [maximized, setMaximized] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const expanded = (hosted ? hosted.maximized : maximized) && !inline && !phone;
  const stageRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const leadLine = useRef(0);
  const front = useRef<(now: number) => number | null>(() => null);
  const cursorsRef = useRef<ReturnType<typeof docCursors>>(null);
  const tags = useRef(d.tags);
  tags.current = d.tags;
  const close = useRef(onClose);
  close.current = onClose;
  const runId = live ? card.runId : card.replay?.at(-1);
  const streaming = live ? gate : true;

  useEffect(() => {
    if (!streaming) return;
    if (!runId) { setPhase("expired"); return; }
    const abort = new AbortController(), stage = stageRef.current!;
    const doc = new VerifyDocShow(live, reducedMotion(), () => linesInView(stage));
    const cursors = cursorsRef.current = docCursors(stage, kind => tags.current[kind], () => follow.current ? leadLine.current : undefined, !live, now => front.current(now), doc);
    let timer: ReturnType<typeof setTimeout> | undefined, last = performance.now();
    front.current = now => doc.front(doc.clock + Math.max(0, now - last));
    // One timer to the next thing due: a glide starts or a mark lands. Nothing runs per frame.
    const pump = () => {
      clearTimeout(timer);
      if (abort.signal.aborted) return;
      const now = performance.now(), step = doc.advance(now - last), end = step.end;
      last = now;
      // Rows a mark adds must be on the page before a cursor measures them.
      if (step.marks.length || end) flushSync(() => setShow(show => {
        const next = step.marks.reduce(apply, show);
        return end ? { ...next, ms: Math.max(next.ms, end.ms), ended: true, blocked: end.blocked } : next;
      }));
      step.left.forEach(cursors.leave);
      // A skim glide keeps its arrival time though drawing the marks above took a while.
      const late = performance.now() - now;
      step.moved.forEach(c => cursors.move(c.ride ? { ...c, duration: Math.max(0, c.duration - late) } : c));
      if (end) { setPhase("done"); return; }
      const wait = doc.due();
      if (wait < Infinity) timer = setTimeout(pump, wait);
    };
    setShow(EMPTY); setPhase("loading"); follow.current = true;
    void (async () => {
      const res = await fetch(route(live ? VERIFY_ROUTES.live : VERIFY_ROUTES.replay, runId), { cache: "no-store", signal: abort.signal });
      if (res.status === 404) { setPhase("unavailable"); return; }
      if (!res.ok || !res.body) { setPhase("failed"); return; }
      const marks: VerifyReplayMark[] = [];
      let total = 0, blocked = false;
      if (live) setPhase("play");
      for await (const chunk of readReplay(res.body)) {
        if (chunk.kind === "end") { total = chunk.end.ms; blocked = chunk.end.status !== "completed"; }
        else if (chunk.kind !== "mark") continue;
        else if (live) { doc.feed(chunk.mark, performance.now() - last); pump(); }
        else marks.push(chunk.mark);
      }
      if (abort.signal.aborted) return;
      if (live) doc.finish(total, blocked, performance.now() - last);
      else {
        // The show paces the rows this stage draws, so the text is on the page before it plans.
        const text = marks.find(mark => mark.kind === "doc-text");
        if (text) flushSync(() => setShow(show => apply(show, text)));
        setPhase("play");
        doc.plan(marks, total, blocked, perRow(stage, text?.lines));
        last = performance.now();
      }
      pump();
    })().catch(() => { if (!abort.signal.aborted) setPhase("failed"); });
    return () => { abort.abort(); clearTimeout(timer); cursors.clear(); front.current = () => null; };
  }, [live, round, runId, streaming]);

  useEffect(() => {
    if (!live || phase !== "play" || !gate) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [gate, live, phase]);

  const ownKeys = !hosted;
  useEffect(() => {
    if (!ownKeys) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (expanded) { event.preventDefault(); setMaximized(false); }
      else close.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, ownKeys]);

  // The view reads down the document: it stays on the first chunk still open while later ones are checked beside it.
  const lead = show.bands.find(band => !band.done);
  leadLine.current = lead?.from ?? 0;
  const target = lead?.from ?? (show.ended ? show.findings[0]?.line : undefined);
  // A replay's camera follows its cursors every frame until the end; the hops below are for live and reduced motion.
  const camera = !live && !reducedMotion(), glide = camera && phase === "play" && !show.ended;
  useEffect(() => {
    if (!glide || !gate) return;
    return docCamera(stageRef.current!, now => {
      const view = cursorsRef.current?.view(now) ?? {}, line = front.current(now), sweep = line === null ? undefined : cursorsRef.current?.lineY(line);
      return sweep === undefined ? view : { ...view, sweep };
    }, () => follow.current, () => { follow.current = false; });
  }, [glide, gate]);
  useEffect(() => {
    const stage = stageRef.current, row = target === undefined ? null : stage?.querySelector<HTMLElement>(`[data-n="${target}"]`);
    if (!stage || !row || !follow.current || camera) return;
    stage.scrollTo({ top: Math.max(0, row.getBoundingClientRect().top - stage.getBoundingClientRect().top + stage.scrollTop - stage.clientHeight / 3), behavior: reducedMotion() ? "auto" : "smooth" });
  }, [target, show.lines]);

  const pages = useMemo(() => {
    const lines = show.lines;
    return lines ? show.starts.map((start, i) => ({ start, end: show.starts[i + 1] ?? lines.length })) : [];
  }, [show.lines, show.starts]);
  const pageOf = (line: number) => Math.max(1, pages.findLastIndex(page => page.start < line) + 1);
  const counts = new Map<VerifyDocKind, number>();
  for (const f of show.findings) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  const status = phase === "expired" ? c.expired : phase === "unavailable" ? c.unavailable : phase === "failed" ? c.failed
    : show.ended ? show.blocked ? d.failed : show.findings.length ? d.problems(show.findings.length) : d.clean
    : lead ? d.checking(pageOf(lead.from), pages.length) : show.bands.length ? d.comparing : c.loading;
  const seconds = Math.round((live && phase === "play" && card.startedAt ? now - card.startedAt : show.ms) / 1000);
  const stop = () => { follow.current = false; };

  return (
    <div className="verify-watch-frame verify-doc-watch" data-inline={inline || undefined} data-maximized={expanded || undefined}>
      <div className="verify-watch-bar">
        <span className="verify-watch-dots" aria-hidden="true"><i /><i /><i /></span>
        <span className="verify-watch-grow" />
        {!hosted && !inline && !phone && <button type="button" className="verify-watch-icon" onClick={() => setMaximized(!maximized)} aria-label={expanded ? c.restore : c.maximize} title={expanded ? c.restore : c.maximize}>{expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>}
        {!hosted && <button type="button" className="verify-watch-icon" onClick={() => close.current()} aria-label={c.close} title={c.close}><X size={15} /></button>}
      </div>
      <div className="verify-watch-address"><span className="verify-watch-url" title={card.entry}>{card.site}</span></div>
      <div ref={stageRef} className="verify-doc-stage" aria-label={c.watch} onWheel={stop} onTouchMove={stop}>
        {show.lines ? <div className="verify-doc-pages">{pages.map((page, i) => {
          const bands = show.bands.filter(band => band.from <= page.end && band.to > page.start);
          const findings = show.findings.filter(f => f.line > page.start && f.line <= page.end);
          return <Sheet key={i} lines={show.lines!} start={page.start} end={page.end} label={c.page(i + 1)} bands={bands} findings={findings} sig={`${bands.map(band => `${band.from}-${band.to}${band.done ? "d" : ""}`).join()}|${findings.length}`} />;
        })}<div className="verify-doc-cursors" aria-hidden="true" /></div> : <div className="verify-doc-wait">{phase === "loading" || phase === "play" ? c.loading : status}</div>}
      </div>
      <div className="verify-watch-line">
        {live && phase === "play" && <span className="verify-watch-live">{c.live}</span>}
        <span data-current>{status}</span>
        <span className="verify-watch-seconds">{seconds}{d.s}</span>
      </div>
      <ul className="verify-doc-tally">{VERIFY_DOC_KINDS.map(kind => (
        <li key={kind} style={{ "--role": DOC_ROLE[kind] } as CSSProperties}><i /><span>{d.kinds[kind]}</span><b key={counts.get(kind) ?? 0} data-issues={counts.get(kind) ? true : undefined}>{counts.get(kind) ?? 0}</b></li>
      ))}</ul>
      {!live && (phase === "done" || phase === "failed") && <button type="button" className="verify-watch-again" onClick={() => setRound(round + 1)}><Play size={14} />{c.again}</button>}
    </div>
  );
}
