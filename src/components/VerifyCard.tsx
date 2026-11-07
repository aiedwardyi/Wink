import { useState } from "react";
import { AlertTriangle, AppWindow, Check, Clock, Loader2, Monitor, Play, RefreshCw, Smartphone } from "lucide-react";
import { LIVE_VERIFY_V0, verifyCardStale, type VerifyCardData, type VerifyErrorCode } from "../../shared/live-verify";
import { useI18n } from "@/lib/i18n";
import { verifyProblem } from "@/lib/verify-copy";
import { lazyView } from "@/lib/stale-build";
import { useIsPhone } from "@/lib/use-phone-swipe";
import { openVerifyWatch, rerunVerify, toggleVerifyWatch, useVerifyWatch, verifyCardAction, verifyCardIn } from "@/lib/verify-watch";
import type { Message } from "@/state/store";
import { LazyView } from "./LazyView";
import "./VerifyCard.css";

const VerifyWatchFrame = lazyView(() => import("./VerifyWatch").then(m => ({ default: m.VerifyWatchFrame })));

const copy = {
  en: { running: "Checking in a real browser", stages: ["Loads", "Links", "Phone"], clean: "Desktop and phone · no problems", cleanCounted: "desktop + phone · no problems", problems: (n: number, fixing: boolean) => `${n} ${n === 1 ? "problem" : "problems"}${fixing ? " · bot is fixing" : ""}`, checks: (n: number) => `${n} ${n === 1 ? "check" : "checks"}`, fixed: (n: number, checks?: number) => `Fixed ${n} ${n === 1 ? "problem" : "problems"} · ${checks === undefined ? "desktop and phone clean" : `${checks} ${checks === 1 ? "check" : "checks"} clean`}`, waiting: "Waiting for another check", details: (n: number) => `${n} ${n === 1 ? "detail" : "details"}`, unchecked: "Not checked", delivery: "form delivery", rerun: "Rerun", watch: "Watch", watchLive: "Watch live", watchCheck: "Watch the check", failed: "Could not check this page", retry: "Could not rerun. Try again.", desktop: "Desktop", phone: "Phone", s: " s" },
  ko: { running: "실제 브라우저에서 확인 중", stages: ["페이지 로드", "링크", "휴대폰"], clean: "데스크톱과 휴대폰 · 문제 없음", cleanCounted: "데스크톱 + 휴대폰 · 문제 없음", problems: (n: number, fixing: boolean) => `문제 ${n}개${fixing ? " · 봇이 수정 중" : ""}`, checks: (n: number) => `확인 ${n}개`, fixed: (n: number, checks?: number) => `문제 ${n}개 해결 · ${checks === undefined ? "데스크톱과 휴대폰 문제 없음" : `확인 ${checks}개 통과`}`, waiting: "다른 확인을 기다리는 중", details: (n: number) => `참고 ${n}개`, unchecked: "확인하지 못함", delivery: "폼 전송", rerun: "다시 확인", watch: "보기", watchLive: "실시간 보기", watchCheck: "확인 과정 보기", failed: "페이지를 확인하지 못했어요", retry: "다시 확인하지 못했어요. 다시 시도하세요.", desktop: "데스크톱", phone: "휴대폰", s: "초" },
};

const coverageKo: Record<string, string> = {
  "form delivery": "폼 전송", "images not loaded": "로드되지 않은 이미지", "external links": "외부 링크",
  fonts: "글꼴", "page errors": "페이지 오류", links: "링크", "phone sideways scroll": "휴대폰 가로 스크롤", "phone menu": "휴대폰 메뉴", leftovers: "남은 임시 문구",
  "phone menu (desktop navigation unavailable)": "휴대폰 메뉴 (데스크톱 탐색을 확인하지 못함)",
};

const blockedKo: Record<string, string> = { code: "의 코드가", requests: "로 가는 요청이", styles: "의 스타일이" };

const errors: Record<VerifyErrorCode, { en: string; ko: string }> = {
  "needs-approval": { en: "approval is needed", ko: "승인이 필요해요" },
  denied: { en: "permission was denied", ko: "확인이 허용되지 않았어요" },
  "desktop-required": { en: "the desktop app is needed", ko: "데스크톱 앱이 필요해요" },
  "outside-folders": { en: "page is outside the working folders", ko: "페이지가 작업 폴더 밖에 있어요" },
  "not-a-site": { en: "no web page was found", ko: "웹 페이지를 찾지 못했어요" },
  busy: { en: "another check is running", ko: "다른 확인이 진행 중이에요" },
  "page-failed": { en: "page could not load", ko: "페이지를 불러오지 못했어요" },
  timeout: { en: "check took too long", ko: "확인 시간이 초과됐어요" },
  cancelled: { en: "check was stopped", ko: "확인이 중단됐어요" },
  "site-changed": { en: "page changed during the check", ko: "확인 중에 페이지가 변경됐어요" },
  "resource-limit": { en: "page exceeded the check's resource limit", ko: "페이지가 확인에 쓸 수 있는 자원 한도를 넘었어요" },
  "isolation-failed": { en: "a separate browser could not be prepared", ko: "별도의 브라우저를 준비하지 못했어요" },
  internal: { en: "check could not finish", ko: "확인을 마치지 못했어요" },
};

export function VerifyCard({ card, threadId, fixerRunning = false }: { card: VerifyCardData; threadId: string; fixerRunning?: boolean }) {
  const { locale } = useI18n();
  const c = copy[locale];
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [inline, setInline] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const phone = useIsPhone();
  if (!LIVE_VERIFY_V0) return null;
  const stale = verifyCardStale(card, Date.now());
  const running = !stale && (card.status === "preparing" || card.status === "running");
  const waiting = !stale && card.status === "waiting";
  const complete = card.status === "completed";
  const issues = card.issues ?? [];
  const details = card.details ?? [];
  const checks = card.counts?.completed || undefined;
  const counted = (text: string) => checks === undefined ? text : `${c.checks(checks)} · ${text}`;
  const seconds = `${Math.max(0, Math.round(((card.endedAt ?? Date.now()) - (card.startedAt ?? card.offeredAt)) / 1000))}${c.s}`;
  const title = waiting ? c.waiting
    : running ? checks === undefined ? c.running : `${c.running} · ${c.checks(checks)}`
    : !complete ? c.failed
    : issues.length ? counted(c.problems(issues.length, fixerRunning))
    : card.fixed ? `${c.fixed(card.fixed, checks === undefined ? undefined : card.counts?.passed ?? checks)} · ${seconds}`
    : `${checks === undefined ? c.clean : counted(c.cleanCounted)} · ${seconds}`;
  const action = verifyCardAction(card, phone);
  const coverage = (reason: string) => {
    if (locale !== "ko") return reason;
    if (coverageKo[reason]) return coverageKo[reason];
    const blocked = /^(scripts|phone layout) \((code|requests|styles) (?:from|to) (\S+) (?:is|are) blocked in the check\)$/.exec(reason);
    if (blocked) return `${blocked[1] === "scripts" ? "스크립트" : "휴대폰 레이아웃"} (${blocked[3]}${blockedKo[blocked[2]!]} 확인 중 차단됨)`;
    const parts = /^(.*) \((desktop|phone)\)$/.exec(reason);
    return parts && coverageKo[parts[1]!] ? `${coverageKo[parts[1]!]} (${parts[2] === "phone" ? c.phone : c.desktop})` : reason;
  };
  const rerun = async () => {
    if (pending) return;
    setPending(true); setError(false);
    try { await rerunVerify(card, threadId); } catch { setError(true); }
    finally { setPending(false); }
  };
  const watch = () => {
    if (phone) setInline(!inline);
    else openVerifyWatch({ threadId, owner: card.owner, live: action === "live" });
  };
  return (
    <section className="verify-card" aria-label={title} data-verify-card>
      <div className="verify-card-heading" role="status" aria-live="polite">
        {waiting ? <Clock size={17} /> : running ? <Loader2 size={17} className="animate-spin" /> : complete && !issues.length ? <Check size={17} /> : <AlertTriangle size={17} />}
        <strong>{title}</strong>
      </div>
      <div className="verify-card-site">{card.site}</div>
      {running || waiting ? <div className="verify-card-stages">{c.stages.map(stage => <span key={stage}>{stage}</span>)}</div> : <>
        {issues.length > 0 && <ul className="verify-card-problems">{issues.map((issue, i) => <li key={`${issue.checker}-${issue.where}-${i}`}>
          <div className="verify-card-location">{issue.tile === "phone" ? <Smartphone size={14} /> : <Monitor size={14} />}<span>{issue.tile === "phone" ? c.phone : c.desktop} · {issue.where}</span></div>
          <div>{verifyProblem(issue, locale)}</div>
        </li>)}</ul>}
        {(card.notChecked ?? []).map(reason => <div className="verify-card-unchecked" key={reason}>{c.unchecked}: {coverage(reason)}</div>)}
        {!complete && <div className="verify-card-unchecked">{c.unchecked}: {(Object.hasOwn(errors, card.errorCode ?? "timeout") ? errors[card.errorCode ?? "timeout"] : errors.internal)[locale]}</div>}
        {details.length > 0 && <>
          <button type="button" className="verify-card-details-toggle" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(!detailsOpen)}>{c.details(details.length)}</button>
          {detailsOpen && <ul className="verify-card-details">{details.map((row, i) => <li key={`${row.checker}-${row.where}-${i}`}>{row.tile === "phone" ? c.phone : c.desktop} · {row.where} · {row.measured}</li>)}</ul>}
        </>}
      </>}
      <div className="verify-card-actions">
        {action === "rerun" && <button type="button" className="verify-card-rerun" onClick={rerun} disabled={pending}><RefreshCw size={13} className={pending ? "animate-spin" : undefined} />{c.rerun}</button>}
        {(action === "live" || action === "watch") && <button type="button" data-verify-watch={action} aria-expanded={phone ? inline : undefined} onClick={watch}><Play size={13} />{action === "live" ? c.watchLive : c.watch}</button>}
      </div>
      {phone && inline && action === "watch" && <LazyView><VerifyWatchFrame card={card} threadId={threadId} live={false} hidden={false} inline onClose={() => setInline(false)} /></LazyView>}
      {error && <div role="alert" className="verify-card-unchecked">{c.retry}</div>}
    </section>
  );
}

/** Chat top bar: a browser icon while the chat's card can be watched; a dot while it streams. */
export function VerifyWatchIcon({ messages, threadId }: { messages: readonly Message[]; threadId: string }) {
  const { locale } = useI18n();
  const open = useVerifyWatch();
  const card = LIVE_VERIFY_V0 ? verifyCardIn(messages) : undefined;
  if (!card || (!card.live && !card.replay?.length)) return null;
  const label = copy[locale].watchCheck;
  return (
    <button
      type="button"
      data-verify-watch-icon
      aria-pressed={open?.threadId === threadId}
      aria-label={label}
      title={label}
      onClick={() => toggleVerifyWatch({ threadId, owner: card.owner, live: verifyCardAction(card, false) === "live" })}
      className="relative rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink aria-pressed:text-accent max-md:hidden"
    >
      <AppWindow size={18} />
      {card.live && <span aria-hidden="true" className="absolute right-1 top-1 size-1.5 rounded-full bg-[#f05d5d]" />}
    </button>
  );
}
