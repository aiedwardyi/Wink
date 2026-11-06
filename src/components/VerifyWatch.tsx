import { useEffect, useRef, useState } from "react";
import { Check, RefreshCw, Volume2, VolumeX, X } from "lucide-react";
import { VERIFY_ROUTES, type VerifyCardData, type VerifyTile } from "../../shared/live-verify";
import { useI18n } from "@/lib/i18n";
import { beatMuted, createBeat, setBeatMuted } from "@/lib/verify-beat";
import { frameBitmap, readReplay } from "@/lib/verify-replay";
import { closeVerifyWatch, rerunVerify, verifyLiveGate } from "@/lib/verify-watch";
import { BANNER_MS, VerifyWatchShow, type Part } from "@/lib/verify-watch-show";
import "./VerifyWatch.css";

const copy = {
  en: { desktop: "Desktop", phone: "Phone", live: "Live", parts: { loads: "Loads", links: "Links", phone: "Phone" }, s: " s", checks: (n: number) => `${n} ${n === 1 ? "check" : "checks"}`, problems: (n: number) => `${n} ${n === 1 ? "problem" : "problems"}`, clean: "No problems", fixed: "Bot fixed it", expired: "Replay expired", failed: "Could not load the replay", unfinished: "Could not check this page", rerun: "Rerun", mute: "Mute", unmute: "Sound on", close: "Close", watch: "Watch the check", rules: { PAGE_ERRORS: "Page errors", LINKS: "Links", FIT: "Phone sideways scroll", NAV: "Phone menu", TEXT_A: "Leftovers" } as Record<string, string> },
  ko: { desktop: "데스크톱", phone: "휴대폰", live: "실시간", parts: { loads: "페이지 로드", links: "링크", phone: "휴대폰" }, s: "초", checks: (n: number) => `확인 ${n}개`, problems: (n: number) => `문제 ${n}개`, clean: "문제 없음", fixed: "봇이 고쳤어요", expired: "다시보기가 만료됐어요", failed: "다시보기를 불러오지 못했어요", unfinished: "페이지를 확인하지 못했어요", rerun: "다시 확인", mute: "소리 끄기", unmute: "소리 켜기", close: "닫기", watch: "확인 과정 보기", rules: { PAGE_ERRORS: "페이지 오류", LINKS: "링크", FIT: "휴대폰 가로 스크롤", NAV: "휴대폰 메뉴", TEXT_A: "남은 임시 문구" } as Record<string, string> },
};
const RULES = ["PAGE_ERRORS", "LINKS", "FIT", "NAV", "TEXT_A"];
const ROLE: Record<string, string> = { PAGE_ERRORS: "#8c95dc", LINKS: "#8db88a", FIT: "#94a3b8", NAV: "#6aa9d8", TEXT_A: "#5eb5a6" };
const TAG: Record<string, string> = { PAGE_ERRORS: "ERRORS", LINKS: "LINKS", FIT: "FIT", NAV: "MENU", TEXT_A: "TEXT" };
const RED = "#f05d5d";
const PARTS: Part[] = ["loads", "links", "phone"];
const ARROW = typeof Path2D === "undefined" ? null : new Path2D("M1.5 1.5 L1.5 17 L5.6 13.2 L8.5 19.6 L11.3 18.4 L8.5 12.2 L13.8 12.2 Z");
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
  inline?: boolean;
  onClose(): void;
}

const TAG_FONT = `10px "Cascadia Mono", ui-monospace, monospace`;
// measureText resolves the font on first use (several ms); the tag font is monospace.
const TAG_CHAR = 6.1;

export function VerifyWatchFrame({ card, threadId, live, hidden, inline = false, onClose }: FrameProps) {
  const { locale } = useI18n();
  const c = copy[locale];
  const visibility = useVisibility();
  const gate = verifyLiveGate(true, hidden, visibility);
  const [show] = useState(() => new VerifyWatchShow(live));
  const [, setVersion] = useState(0);
  const [muted, setMuted] = useState(beatMuted);
  const [rerunning, setRerunning] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bitmap = useRef<{ jpeg: Uint8Array; image: ImageBitmap } | null>(null);
  const runs = useRef(card.replay ?? []);
  const close = useRef(onClose);
  close.current = onClose;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

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
      if (!ended) return false;
      await show.settled();
      return !abort.signal.aborted && show.phase === "after";
    };
    void (async () => {
      if (live) {
        if (await play(route(VERIFY_ROUTES.live, card.runId))) show.finish();
        return;
      }
      for (const [i, runId] of runs.current.entries()) {
        const last = i === runs.current.length - 1;
        if (await play(route(VERIFY_ROUTES.replay, runId))) { if (!last) await show.between(); }
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
    const beat = createBeat();
    let last = performance.now(), frame = 0, drawn = -1, shown = -1;
    const tick = (now: number) => {
      show.advance(now - last);
      last = now;
      const playing = ["play", "reel", "clean", "between"].includes(show.phase);
      if (playing && !mutedRef.current) beat.sync(show.clock);
      else beat.stop();
      if (show.version !== drawn) { drawn = show.version; draw(); }
      if (show.ui !== shown) { shown = show.ui; setVersion(shown); }
      if (show.clock >= show.closeAt) { close.current(); return; }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); beat.close(); };
  }, [gate, show]);

  useEffect(() => {
    if (inline) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) close.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inline]);

  useEffect(() => () => bitmap.current?.image.close(), []);

  function draw() {
    const canvas = canvasRef.current, ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const tile = show.tile;
    const [w, h] = tileSize(show);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const stored = show.frame();
    if (stored && bitmap.current?.jpeg !== stored.jpeg) {
      const jpeg = stored.jpeg;
      void frameBitmap(jpeg).then(image => {
        if (show.frame()?.jpeg !== jpeg) { image.close(); return; }
        bitmap.current?.image.close();
        bitmap.current = { jpeg, image };
        draw();
      }, () => {});
    }
    ctx.fillStyle = "#0a0d14";
    ctx.fillRect(0, 0, w, h);
    if (bitmap.current && stored && bitmap.current.jpeg === stored.jpeg) ctx.drawImage(bitmap.current.image, 0, 0, w, h);
    const px = Math.max(w / Math.max(1, canvas.clientWidth || w), h / Math.max(1, canvas.clientHeight || h));
    ctx.lineWidth = px;
    const reel = show.reelIssue();
    if (reel?.box) {
      const [x, y, bw, bh] = reel.box;
      ctx.fillStyle = "rgba(240, 93, 93, 0.12)";
      ctx.fillRect(x, y, bw, bh);
      ctx.lineWidth = 2 * px;
      ctx.strokeStyle = RED;
      ctx.strokeRect(x, y, bw, bh);
      handles(ctx, x, y, bw, bh, RED, px);
      return;
    }
    if (show.phase !== "play" && show.phase !== "loading") return;
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
    for (const [checker, cursor] of show.cursors) {
      if (cursor.tile !== tile) continue;
      const p = show.cursorAt(cursor), color = ROLE[checker] ?? "#e2e8f0", tag = TAG[checker] ?? checker;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.scale(px, px);
      ctx.fillStyle = color; ctx.strokeStyle = "#f8fafc"; ctx.lineWidth = 1.2;
      ctx.fill(ARROW); ctx.stroke(ARROW);
      ctx.fillRect(11, 15, tag.length * TAG_CHAR + 8, 14);
      ctx.fillStyle = "#0a0d14";
      ctx.fillText(tag, 15, 25);
      ctx.restore();
    }
  }

  const tile = show.tile;
  const head = show.head;
  const reel = show.reelIssue();
  const issues = show.end?.issues ?? [];
  const seconds = Math.round(show.ms / 1000);
  const current = PARTS.find(part => !show.parts.has(part));
  const rules = [...RULES, ...[...show.byChecker.keys()].filter(id => !RULES.includes(id))];
  const banner = show.phase === "between" ? c.fixed : show.phase === "expired" ? c.expired : show.phase === "failed" ? show.end?.status === "blocked" ? c.unfinished : c.failed : show.phase === "clean" ? c.clean : null;
  const toggleMute = () => { setBeatMuted(!muted); setMuted(!muted); };
  const rerun = async () => {
    if (rerunning) return;
    setRerunning(true);
    try { await rerunVerify(card, threadId); close.current(); } catch { /* the card shows the retry */ } finally { setRerunning(false); }
  };

  return (
    <div className="verify-watch-frame" data-inline={inline || undefined}>
      <div className="verify-watch-bar">
        <span className="verify-watch-dots" aria-hidden="true"><i /><i /><i /></span>
        <div role="tablist" className="verify-watch-tabs">
          {(["desktop", "phone"] as VerifyTile[]).map(id => (
            <button key={id} type="button" role="tab" aria-selected={tile === id} onClick={() => show.pin(id)}>{id === "phone" ? c.phone : c.desktop}</button>
          ))}
        </div>
        <span className="verify-watch-grow" />
        <button type="button" className="verify-watch-icon" onClick={toggleMute} aria-label={muted ? c.unmute : c.mute} title={muted ? c.unmute : c.mute}>{muted ? <VolumeX size={15} /> : <Volume2 size={15} />}</button>
        <button type="button" className="verify-watch-icon" onClick={() => close.current()} aria-label={c.close} title={c.close}><X size={15} /></button>
      </div>
      <div className="verify-watch-address">
        <button type="button" className="verify-watch-icon" onClick={rerun} disabled={rerunning || card.status === "running" || card.status === "preparing"} aria-label={c.rerun} title={c.rerun}><RefreshCw size={14} className={rerunning ? "animate-spin" : undefined} /></button>
        <span className="verify-watch-url" title={head?.page}>{head?.site ?? card.site}</span>
      </div>
      <div className="verify-watch-stage" data-tile={tile} style={{ aspectRatio: tileSize(show).join(" / ") }} onClick={inline ? () => close.current() : undefined}>
        <canvas ref={canvasRef} aria-label={c.watch} />
        {(show.phase === "after" || show.phase === "done" || show.phase === "reel" || show.phase === "clean") && show.end && (
          <div className="verify-watch-pill">{c.checks(show.checks)} · <span data-red={issues.length > 0 || undefined}>{issues.length ? c.problems(issues.length) : c.clean}</span></div>
        )}
        {reel && <div className="verify-watch-caption"><b>{reel.tile === "phone" ? c.phone : c.desktop} · {reel.where}</b><span>{reel.measured}</span></div>}
        {banner && <div className="verify-watch-banner" role="status">{banner}</div>}
      </div>
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

/** Docked right inside the chat column; the chat stays usable beside it. */
export function VerifyWatchPanel({ card, threadId, live, hidden }: { card: VerifyCardData; threadId: string; live: boolean; hidden: boolean }) {
  return (
    <aside className="verify-watch" data-verify-watch>
      <VerifyWatchFrame key={`${card.runId}:${live}`} card={card} threadId={threadId} live={live} hidden={hidden} onClose={closeVerifyWatch} />
    </aside>
  );
}
