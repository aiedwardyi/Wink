import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, Maximize2, Minimize2, Play, RefreshCw, X } from "lucide-react";
import { VERIFY_ROUTES, type VerifyCardData, type VerifyTile } from "../../shared/live-verify";
import { useI18n } from "@/lib/i18n";
import { EASE_STANDARD, MOTION_LARGE_MS } from "@/lib/motion";
import { reducedMotion } from "@/lib/phone-swipe";
import { useIsPhone } from "@/lib/use-phone-swipe";
import { VERIFY_ROLE as ROLE, VERIFY_TAG as TAG, verifyProblem } from "@/lib/verify-copy";
import { frameBitmap, readReplay } from "@/lib/verify-replay";
import { chooseVerifyTab, rerunVerify, setVerifyShowing, verifyChosenTab, verifyLiveGate } from "@/lib/verify-watch";
import { BANNER_MS, CURSOR_ARROW, VerifyWatchShow, tagSpot, type Part } from "@/lib/verify-watch-show";
import "./VerifyWatch.css";

const copy = {
  en: { desktop: "Desktop", phone: "Phone", live: "Live", parts: { loads: "Loads", links: "Links", phone: "Phone" }, s: " s", checks: (n: number) => `${n} ${n === 1 ? "check" : "checks"}`, problems: (n: number) => `${n} ${n === 1 ? "problem" : "problems"}`, clean: "No problems", fixed: "Bot fixed it", waiting: "Waiting for another check", expired: "Replay expired", failed: "Could not load the replay", unfinished: "Could not check this page", rerun: "Rerun", retry: "Could not rerun. Try again.", close: "Close", maximize: "Maximize", restore: "Restore", again: "Watch again", watch: "Watch the check", rules: { PAGE_ERRORS: "Page errors", LINKS: "Links", FIT: "Phone fit", NAV: "Phone menu", TEXT_A: "Leftovers" } as Record<string, string> },
  ko: { desktop: "데스크톱", phone: "휴대폰", live: "실시간", parts: { loads: "페이지 로드", links: "링크", phone: "휴대폰" }, s: "초", checks: (n: number) => `확인 ${n}개`, problems: (n: number) => `문제 ${n}개`, clean: "문제 없음", fixed: "봇이 고쳤어요", waiting: "다른 확인을 기다리는 중", expired: "다시보기가 만료됐어요", failed: "다시보기를 불러오지 못했어요", unfinished: "페이지를 확인하지 못했어요", rerun: "다시 확인", retry: "다시 확인하지 못했어요. 다시 시도하세요.", close: "닫기", maximize: "크게 보기", restore: "원래 크기", again: "다시 보기", watch: "확인 과정 보기", rules: { PAGE_ERRORS: "페이지 오류", LINKS: "링크", FIT: "휴대폰 맞춤", NAV: "휴대폰 메뉴", TEXT_A: "남은 임시 문구" } as Record<string, string> },
};
const RULES = ["PAGE_ERRORS", "LINKS", "FIT", "NAV", "TEXT_A"];
const RED = "#f05d5d";
const PARTS: Part[] = ["loads", "links", "phone"];
const ARROW = typeof Path2D === "undefined" ? null : new Path2D(CURSOR_ARROW);
const route = (path: string, runId: string) => path.replace(":runId", encodeURIComponent(runId));
const tileSize = (show: VerifyWatchShow) => show.head?.tiles[show.tile] ?? (show.tile === "phone" ? [392, 800] : [1280, 720]);

function useVisibility() {
  const [visibility, setVisibility] = useState(() => document.visibilityState);
  useEffect(() => {
    const flip = () => setVisibility(document.visibilityState);
    document.addEventListener("visibilitychange", flip);
    return () => document.removeEventListener("visibilitychange", flip);
  }, []);
  return visibility;
}

interface FrameProps {
  card: VerifyCardData;
  threadId: string;
  /** stream the running check instead of the kept replays */
  live: boolean;
  hidden: boolean;
  closing?: boolean;
  inline?: boolean;
  /** inside the Show pane, whose header holds Maximize and Close */
  hosted?: { maximized: boolean };
  onClose(): void;
}

const TAG_FONT = `10px "Cascadia Mono", ui-monospace, monospace`;
// measureText resolves the font on first use (several ms); the tag font is monospace.
const TAG_CHAR = 6.1;

export function VerifyWatchFrame({ card, threadId, live, hidden, closing = false, inline = false, hosted, onClose }: FrameProps) {
  const { locale } = useI18n();
  const c = copy[locale];
  const phone = useIsPhone();
  const visibility = useVisibility();
  const gate = verifyLiveGate(!closing, hidden, visibility);
  const [show, setShow] = useState(() => new VerifyWatchShow(live, verifyChosenTab(card.runId)));
  const [maximized, setMaximized] = useState(false);
  const expanded = (hosted ? hosted.maximized : maximized) && !inline && !phone;
  const [, setVersion] = useState(0);
  const [, setDecoded] = useState(0);
  const [rerunning, setRerunning] = useState(false);
  const [error, setError] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const stageHeight = useRef<number | null>(null);
  const bitmap = useRef<{ jpeg: Uint8Array; image: ImageBitmap; tile: VerifyTile } | null>(null);
  const undecodable = useRef<Uint8Array | null>(null);
  const runs = useRef(card.replay ?? []);
  const close = useRef(onClose);
  close.current = onClose;

  const streaming = live ? gate : true;
  useEffect(() => {
    if (!streaming || show.phase === "done") return;
    const abort = new AbortController();
    const play = async (path: string) => {
      show.beginRun();
      const res = await fetch(path, { cache: "no-store", signal: abort.signal });
      if (res.status === 404) { show.expire(); return false; }
      if (!res.ok || !res.body) { show.fail(); return false; }
      let ended = false;
      for await (const chunk of readReplay(res.body)) {
        show.feed(chunk);
        if (chunk.kind === "end") ended = true;
      }
      if (!ended) {
        if (!live) show.fail();
        return false;
      }
      await show.settled();
      return !abort.signal.aborted && show.phase === "after";
    };
    void (async () => {
      if (live) {
        if (await play(route(VERIFY_ROUTES.live, card.runId))) show.finish();
        return;
      }
      for (const [i, runId] of runs.current.entries()) {
        const previous = { head: show.head, end: show.end };
        const last = i === runs.current.length - 1;
        if (await play(route(VERIFY_ROUTES.replay, runId))) {
          const fixed = Boolean(previous.head?.site && previous.head.page && previous.head.site === show.head?.site && previous.head.page === show.head.page
            && previous.end?.status === "completed" && previous.end.issues.length && show.end?.status === "completed" && !show.end.issues.length);
          if (fixed || !last) await show.between(fixed);
        }
        // a recorded blocked check is one run of the chain; a replay that would not load ends it
        else if (last || abort.signal.aborted || show.end?.status !== "blocked") return;
        else await show.waitFor(BANNER_MS);
      }
      if (!abort.signal.aborted) show.finish();
    })().catch(() => { if (!abort.signal.aborted) show.fail(); });
    return () => abort.abort();
  }, [card.runId, live, show, streaming]);

  useEffect(() => {
    if (!gate) return;
    let last = performance.now(), frame = 0, drawn = -1, shown = -1;
    const tick = (now: number) => {
      show.advance(awaiting() ? 0 : now - last);
      last = now;
      if (show.version !== drawn) { drawn = show.version; draw(); }
      if (show.ui !== shown) {
        shown = show.ui;
        setVersion(shown);
        if (!live) setVerifyShowing(show.showing ? { runId: card.runId, checks: show.checks, by: show.lanes } : null);
      }
      if (live && show.clock >= show.closeAt) { close.current(); return; }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); };
  }, [card.runId, gate, live, show]);

  useEffect(() => () => setVerifyShowing(null), []);

  useEffect(() => {
    if (!inline) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target as Element;
      if (!frameRef.current?.contains(target) && !target.closest("[data-verify-card] [data-verify-watch]")) close.current();
    };
    // Capture, because a button inside can unmount on its own click before bubbling gets here.
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [inline]);

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

  useEffect(() => () => bitmap.current?.image.close(), []);
  useLayoutEffect(() => { draw(); }, [expanded, show]);

  // The show's clock waits for a tile's first picture, so the stage is never painted before it.
  function awaiting() {
    if (bitmap.current?.tile === show.tile) return false;
    if (show.phase === "loading") return true;
    const stored = show.frame();
    return Boolean(stored && canvasRef.current?.getContext("2d")) && undecodable.current !== stored!.jpeg;
  }

  function draw() {
    const canvas = canvasRef.current, ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const tile = show.tile;
    const [w, h] = tileSize(show);
    const px = Math.max(w / Math.max(1, canvas.clientWidth || w), h / Math.max(1, canvas.clientHeight || h));
    const k = Math.min(2, Math.max(1, Math.round((window.devicePixelRatio || 1) / px * 4) / 4)), cw = Math.round(w * k), ch = Math.round(h * k);
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    if (k !== 1) ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.imageSmoothingQuality = "high";
    const stored = show.frame();
    if (stored && bitmap.current?.jpeg !== stored.jpeg) {
      const jpeg = stored.jpeg;
      void frameBitmap(jpeg).then(image => {
        if (show.frame()?.jpeg !== jpeg) { image.close(); return; }
        bitmap.current?.image.close();
        bitmap.current = { jpeg, image, tile };
        draw();
        setDecoded(n => n + 1);
      }, () => { undecodable.current = jpeg; setDecoded(n => n + 1); });
    }
    ctx.fillStyle = "#0a0d14";
    ctx.fillRect(0, 0, w, h);
    // The last picture stays up while the next one decodes, so a scroll stop never flashes black.
    if (bitmap.current?.tile === tile) ctx.drawImage(bitmap.current.image, 0, 0, w, h);
    ctx.lineWidth = px;
    const reel = show.reelIssue();
    if (reel?.box) {
      if (!stored) return;
      const [x, by, bw, bh] = reel.box;
      const y = by + (reel.scrollY ?? 0) - stored.scrollY;
      ctx.fillStyle = "rgba(240, 93, 93, 0.12)";
      ctx.fillRect(x, y, bw, bh);
      ctx.lineWidth = 2 * px;
      ctx.strokeStyle = RED;
      ctx.strokeRect(x, y, bw, bh);
      handles(ctx, x, y, bw, bh, RED, px);
      return;
    }
    if (show.phase !== "play" && show.phase !== "loading" || !live && bitmap.current?.tile !== tile) return;
    for (const outline of show.outlines) {
      if (outline.tile !== tile) continue;
      const alpha = show.outlineAlpha(outline);
      if (alpha <= 0) continue;
      const r = show.view(outline), color = outline.issue ? RED : ROLE[outline.checker] ?? "#e2e8f0";
      ctx.globalAlpha = alpha;
      if (outline.issue) { ctx.fillStyle = "rgba(240, 93, 93, 0.1)"; ctx.fillRect(r.x, r.y, r.w, r.h); }
      ctx.strokeStyle = color;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      handles(ctx, r.x, r.y, r.w, r.h, color, px);
    }
    ctx.globalAlpha = 1;
    if (show.ring?.tile === tile) {
      const k = Math.min(1, (show.clock - show.ring.at) / 172), rad = (3 + 17 * (1 - (1 - k) ** 3)) * px;
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = "#f8fafc";
      ctx.lineWidth = 1.5 * px;
      ctx.beginPath(); ctx.arc(show.ring.x, show.ring.y, rad, 0, 2 * Math.PI); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#f8fafc";
      ctx.beginPath(); ctx.arc(show.ring.x, show.ring.y, 3 * px, 0, 2 * Math.PI); ctx.fill();
    }
    if (!ARROW) return;
    ctx.font = TAG_FONT;
    for (const cursor of show.cursors.values()) {
      if (cursor.tile !== tile) continue;
      const { checker } = cursor, p = show.cursorAt(cursor, reducedMotion()), color = ROLE[checker] ?? "#e2e8f0", tag = TAG[checker] ?? checker;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.scale(px, px);
      ctx.fillStyle = color; ctx.strokeStyle = "#f8fafc"; ctx.lineWidth = 1.2;
      ctx.fill(ARROW); ctx.stroke(ARROW);
      const width = tag.length * TAG_CHAR + 8, spot = tagSpot(cursor, p, width, [w, h], px);
      if (spot) {
        ctx.fillRect(spot.x, spot.y, width, 14);
        ctx.fillStyle = "#0a0d14";
        ctx.fillText(tag, spot.x + 4, spot.y + 10);
      }
      ctx.restore();
    }
  }

  const tile = show.tile;
  const head = show.head;
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const height = stage.getBoundingClientRect().height, previous = stageHeight.current;
    stageHeight.current = height;
    if (previous === null || previous === height || reducedMotion() || !stage.animate) return;
    const animation = stage.animate([{ height: `${previous}px` }, { height: `${height}px` }], { duration: MOTION_LARGE_MS, easing: EASE_STANDARD });
    return () => { stageHeight.current = stage.getBoundingClientRect().height; animation.cancel(); };
  }, [tile, head]);
  const reel = show.reelIssue();
  const pillTop = reel?.box && reel.box[1] + (reel.scrollY ?? 0) - (show.frame()?.scrollY ?? 0) + reel.box[3] / 2 > tileSize(show)[1] / 2;
  const caption = reel && <div className="verify-watch-caption"><b>{reel.tile === "phone" ? c.phone : c.desktop} · {reel.where}</b><span>{verifyProblem(reel, locale)}</span></div>;
  const issues = show.end?.issues ?? [];
  const seconds = Math.round(show.ms / 1000);
  const current = PARTS.find(part => !show.parts.has(part));
  const rules = [...RULES, ...[...show.byChecker.keys()].filter(id => !RULES.includes(id))];
  const banner = show.phase === "between" ? show.fixed ? c.fixed : c.waiting : show.phase === "expired" ? c.expired : show.phase === "failed" ? show.end?.status === "blocked" ? c.unfinished : c.failed : show.phase === "clean" ? c.clean : null;
  const rerun = async () => {
    if (rerunning) return;
    setRerunning(true); setError(false);
    try { await rerunVerify(card, threadId); close.current(); } catch { setError(true); } finally { setRerunning(false); }
  };

  return (
    <div ref={frameRef} className="verify-watch-frame" data-inline={inline || undefined} data-maximized={expanded || undefined}>
      <div className="verify-watch-bar">
        <span className="verify-watch-dots" aria-hidden="true"><i /><i /><i /></span>
        <div role="tablist" className="verify-watch-tabs">
          {show.tabs.map(id => (
            <button key={id} type="button" role="tab" aria-selected={tile === id} onClick={() => { show.pin(id); chooseVerifyTab(card.runId, id); }}>{id === "phone" ? c.phone : c.desktop}</button>
          ))}
        </div>
        <span className="verify-watch-grow" />
        {!hosted && !inline && !phone && <button type="button" className="verify-watch-icon" onClick={() => setMaximized(!maximized)} aria-label={expanded ? c.restore : c.maximize} title={expanded ? c.restore : c.maximize}>{expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>}
        {!hosted && <button type="button" className="verify-watch-icon" onClick={() => close.current()} aria-label={c.close} title={c.close}><X size={15} /></button>}
      </div>
      <div className="verify-watch-address">
        <button type="button" className="verify-watch-icon" onClick={rerun} disabled={rerunning || card.status === "running" || card.status === "preparing"} aria-label={c.rerun} title={c.rerun}><RefreshCw size={14} className={rerunning ? "animate-spin" : undefined} /></button>
        <span className="verify-watch-url" title={head?.page}>{head?.site ?? card.site}</span>
      </div>
      {error && <div className="verify-watch-error" role="alert">{c.retry}</div>}
      <div ref={stageRef} className="verify-watch-stage" data-tile={tile} data-pending={awaiting() || undefined} style={{ aspectRatio: tileSize(show).join(" / ") }}>
        <canvas ref={canvasRef} aria-label={c.watch} />
        {(show.phase === "after" || show.phase === "done" || show.phase === "reel" || show.phase === "clean") && show.end && (
          <div className="verify-watch-pill" data-top={pillTop || undefined}>{c.checks(show.checks)} · <span data-red={issues.length > 0 || undefined}>{issues.length ? c.problems(issues.length) : c.clean}</span></div>
        )}
        {banner && <div className="verify-watch-banner" role="status">{banner}</div>}
      </div>
      {caption}
      <div className="verify-watch-line">
        {live && <span className="verify-watch-live">{c.live}</span>}
        {PARTS.map(part => (
          <span key={part} data-done={show.parts.has(part) || undefined} data-current={part === current && show.phase === "play" || undefined}>
            {show.parts.has(part) && <Check size={12} />}{c.parts[part]}
          </span>
        ))}
        <span className="verify-watch-seconds">{seconds}{c.s}</span>
      </div>
      <div className="verify-watch-checks">
        <div className="verify-watch-count">{c.checks(show.checks)}</div>
        <ul>
          {rules.map(id => {
            const row = show.byChecker.get(id);
            return (
              <li key={id} data-issue={row?.issues ? true : undefined}>
                <i style={{ background: row?.issues ? RED : ROLE[id] ?? "#94a3b8" }} />
                <span>{c.rules[id] ?? id}</span>
                <b>{row?.done ?? 0}</b>
                {row?.issues ? <X size={12} /> : row?.done ? <Check size={12} /> : null}
              </li>
            );
          })}
        </ul>
      </div>
      {!live && (show.phase === "done" || show.phase === "failed" && show.end) && <button type="button" className="verify-watch-again" onClick={() => { setError(false); setShow(new VerifyWatchShow(false, show.pinned)); }}><Play size={14} />{c.again}</button>}
    </div>
  );
}

function handles(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, px: number) {
  const s = 5 * px;
  ctx.fillStyle = "#f8fafc";
  ctx.strokeStyle = color;
  for (const [hx, hy] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]] as const) {
    ctx.fillRect(hx - s / 2, hy - s / 2, s, s);
    ctx.strokeRect(hx - s / 2, hy - s / 2, s, s);
  }
}
