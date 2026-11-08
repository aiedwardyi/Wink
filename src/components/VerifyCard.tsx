import { useEffect, useRef, useState, type CSSProperties } from "react";
import { AppWindow, Monitor, MousePointerClick, Play, RefreshCw } from "lucide-react";
import { LIVE_VERIFY_V0, verifyCardStale, type VerifyCardData, type VerifyChecker, type VerifyCounts, type VerifyErrorCode, type VerifyTile } from "../../shared/live-verify";
import { useI18n } from "@/lib/i18n";
import { VERIFY_ROLE, VERIFY_TAG, verifyProblem } from "@/lib/verify-copy";
import { lazyView } from "@/lib/stale-build";
import { useIsPhone } from "@/lib/use-phone-swipe";
import { openVerifyWatch, rerunVerify, toggleVerifyWatch, useVerifyWatch, verifyCardAction, verifyCardIn } from "@/lib/verify-watch";
import type { Message } from "@/state/store";
import { LazyView } from "./LazyView";
import "./VerifyCard.css";

const VerifyWatchFrame = lazyView(() => import("./VerifyWatch").then(m => ({ default: m.VerifyWatchFrame })));

const copy = {
  en: { head: (site: string) => `Live Verify · ${site}`, sizes: "Desktop 1280 · phone 392", plan: ["Reads text, headings and links", "Checks the menu and clicks buttons", "Measures the phone layout and tap sizes"], tally: { passed: () => "passed", issues: (n: number) => n === 1 ? "issue" : "issues", blocked: () => "blocked", notRun: () => "not run" }, showAll: (n: number) => `Show all ${n}`, fixedOnly: (n: number) => `Fixed ${n} ${n === 1 ? "problem" : "problems"}`, watchPhone: "Watch on your computer", running: "Checking in a real browser", clean: "Desktop and phone · no problems", cleanCounted: "desktop + phone · no problems", problems: (n: number, fixing: boolean) => `${n} ${n === 1 ? "problem" : "problems"}${fixing ? " · bot is fixing" : ""}`, checks: (n: number) => `${n} ${n === 1 ? "check" : "checks"}`, fixed: (n: number, checks?: number) => `Fixed ${n} ${n === 1 ? "problem" : "problems"} · ${checks === undefined ? "desktop and phone clean" : `${checks} ${checks === 1 ? "check" : "checks"} clean`}`, waiting: "Waiting for another check", details: (n: number) => `${n} ${n === 1 ? "detail" : "details"}`, unchecked: "Not checked", delivery: "form delivery", rerun: "Rerun", watch: "Watch", watchCheck: "Watch the check", failed: "Could not check this page", retry: "Could not rerun. Try again.", desktop: "Desktop", phone: "Phone", s: " s" },
  ko: { head: (site: string) => `Live Verify · ${site}`, sizes: "데스크톱 1280 · 휴대폰 392", plan: ["글, 제목, 링크를 읽어요", "메뉴를 확인하고 버튼을 눌러요", "휴대폰 화면 맞춤과 누르는 영역 크기를 재요"], tally: { passed: () => "통과", issues: () => "문제", blocked: () => "막힘", notRun: () => "실행 안 됨" }, showAll: (n: number) => `${n}개 모두 보기`, fixedOnly: (n: number) => `문제 ${n}개 해결`, watchPhone: "컴퓨터에서 보기", running: "실제 브라우저에서 확인 중", clean: "데스크톱과 휴대폰 · 문제 없음", cleanCounted: "데스크톱 + 휴대폰 · 문제 없음", problems: (n: number, fixing: boolean) => `문제 ${n}개${fixing ? " · 봇이 수정 중" : ""}`, checks: (n: number) => `확인 ${n}개`, fixed: (n: number, checks?: number) => `문제 ${n}개 해결 · ${checks === undefined ? "데스크톱과 휴대폰 문제 없음" : `확인 ${checks}개 통과`}`, waiting: "다른 확인을 기다리는 중", details: (n: number) => `참고 ${n}개`, unchecked: "확인하지 못함", delivery: "폼 전송", rerun: "다시 확인", watch: "보기", watchCheck: "확인 과정 보기", failed: "페이지를 확인하지 못했어요", retry: "다시 확인하지 못했어요. 다시 시도하세요.", desktop: "데스크톱", phone: "휴대폰", s: "초" },
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

const SHOWN = 5;
const TILES = ["desktop", "phone"] as const;
// Plan rows by the real runner's checkers; the watched runner's extra checkers fold into the same rows.
const PLAN: VerifyChecker[][] = [["TEXT_A", "TEXT_B", "HEADINGS", "LINKS", "FONT", "CONTRAST", "PAGE_ERRORS"], ["NAV", "BUTTONS", "CLICK", "FORM"], ["FIT"]];
const DOTS: VerifyChecker[][] = [["TEXT_A", "LINKS"], ["NAV"], ["FIT"]];
const LANES: VerifyChecker[] = ["TEXT_A", "LINKS", "PAGE_ERRORS", "NAV", "FIT"];
type By = NonNullable<VerifyCounts["by"]>;
const pairs = (by: By, checkers: VerifyChecker[]) => checkers.flatMap(checker => TILES.flatMap(tile => by[checker]?.[tile] ? [by[checker]![tile]!] : []));
const active = (by: By, checkers: VerifyChecker[]) => pairs(by, checkers).some(([done, planned]) => done < planned);
// Each tile is half the lane, so a lane only moves forward when the phone pass adds its list.
const share = (by: By, checker: VerifyChecker) => TILES.reduce((sum, tile) => {
  const pair = by[checker]?.[tile];
  return sum + (pair ? pair[1] ? pair[0] / pair[1] : 1 : 0);
}, 0) / TILES.length;
const rowState = (by: By | undefined, checkers: VerifyChecker[]) => !by ? undefined : active(by, checkers) ? "running" : pairs(by, checkers).length ? "done" : "waiting";
const dot = (checker: VerifyChecker) => <i key={checker} style={{ background: VERIFY_ROLE[checker] ?? VERIFY_ROLE.FIT }} />;

export function VerifyCard({ card, threadId, fixerRunning = false }: { card: VerifyCardData; threadId: string; fixerRunning?: boolean }) {
  const { locale } = useI18n();
  const c = copy[locale];
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [inline, setInline] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [all, setAll] = useState(false);
  const phone = useIsPhone();
  const ref = useRef<HTMLElement>(null);
  const stale = verifyCardStale(card, Date.now());
  const running = !stale && (card.status === "preparing" || card.status === "running");
  useEffect(() => {
    const el = ref.current;
    if (!running || !el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => el.toggleAttribute("data-off", !entry!.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, [running]);
  if (!LIVE_VERIFY_V0) return null;
  const waiting = !stale && card.status === "waiting";
  const complete = card.status === "completed";
  const issues = card.issues ?? [];
  const details = card.details ?? [];
  const checks = card.counts?.completed || undefined;
  // Older runners send totals only: their rows stay neutral and the lanes stay hidden.
  const by = card.counts ? card.counts.by : {};
  const counted = (text: string) => checks === undefined ? text : `${c.checks(checks)} · ${text}`;
  const seconds = `${Math.max(0, Math.round(((card.endedAt ?? Date.now()) - (card.startedAt ?? card.offeredAt)) / 1000))}${c.s}`;
  const title = waiting ? c.waiting
    : running ? checks === undefined ? c.running : `${c.running} · ${c.checks(checks)}`
    : !complete ? c.failed
    : issues.length ? counted(c.problems(issues.length, fixerRunning))
    : card.fixed ? `${c.fixed(card.fixed, checks === undefined ? undefined : card.counts?.passed ?? checks)} · ${seconds}`
    : `${checks === undefined ? c.clean : counted(c.cleanCounted)} · ${seconds}`;
  const action = verifyCardAction(card, phone);
  const tile = (name: VerifyTile) => name === "phone" ? c.phone : c.desktop;
  const tally = complete && card.counts ? ([["passed", card.counts.passed], ["issues", issues.length], ["blocked", card.counts.blocked], ["notRun", card.counts.notRun]] as const).filter(([, n]) => n > 0) : [];
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
    <section ref={ref} className="verify-card" data-active={running || waiting || undefined} aria-label={title} data-verify-card>
      <div className="verify-card-head" role="status" aria-live="polite">
        <MousePointerClick size={14} />
        <span className="verify-card-title">{c.head(card.site)}</span>
        {running ? <span className="verify-card-side">
          {checks !== undefined && <span className="verify-card-count">{c.checks(checks)}</span>}
          {action === "live" && <button type="button" data-verify-watch="live" onClick={watch}>{c.watch}</button>}
        </span> : !phone && <span className="verify-card-side">{c.sizes}</span>}
      </div>
      {running || waiting ? <>
        {waiting && <div className="verify-card-strip">{c.waiting}</div>}
        <ul className="verify-card-plan">{c.plan.map((text, i) => <li key={text} data-state={waiting ? "waiting" : rowState(by, PLAN[i]!)}>
          <span className="verify-card-dots">{DOTS[i]!.map(dot)}</span><span>{text}</span>
        </li>)}</ul>
        {running && by && <div className="verify-card-lanes" aria-hidden="true">{LANES.map(checker => {
          const fill = share(by, checker) * 10, on = active(by, [checker]);
          return <div key={checker} data-on={on || undefined} style={{ "--role": VERIFY_ROLE[checker] } as CSSProperties}>
            <span className="verify-card-tag">{dot(checker)}{VERIFY_TAG[checker]}</span>
            <span className="verify-card-seg">{Array.from({ length: 10 }, (_, i) => <i key={i} data-lead={on && i === Math.min(9, Math.floor(fill)) || undefined} style={{ "--k": Math.min(1, Math.max(0, fill - i)) } as CSSProperties} />)}</span>
          </div>;
        })}</div>}
        {phone && running && card.live && <div className="verify-card-phone-watch"><Monitor size={14} />{c.watchPhone}</div>}
      </> : <>
        <div className="verify-card-strip">{tally.length ? <>
          {card.fixed ? <span>{c.fixedOnly(card.fixed)}</span> : null}
          {tally.map(([key, n]) => <span key={key}><b data-issues={key === "issues" || undefined}>{n}</b> {c.tally[key](n)}</span>)}
        </> : title}</div>
        {issues.length > 0 && <ol className="verify-card-problems">{(all ? issues : issues.slice(0, SHOWN)).map((issue, i) => <li key={`${issue.checker}-${issue.where}-${i}`}>
          <span className="verify-card-tag">{dot(issue.checker)}{VERIFY_TAG[issue.checker] ?? issue.checker}</span>
          <span className="verify-card-tile">{tile(issue.tile)}</span>
          <span className="verify-card-where"><span className="verify-card-tile-inline">{tile(issue.tile)} · </span>{issue.where}</span>
          <span className="verify-card-measure">{verifyProblem(issue, locale)}</span>
        </li>)}</ol>}
        {!all && issues.length > SHOWN && <button type="button" className="verify-card-more" onClick={() => setAll(true)}>{c.showAll(issues.length)}</button>}
        {(card.notChecked ?? []).map(reason => <div className="verify-card-unchecked" key={reason}>{c.unchecked}: {coverage(reason)}</div>)}
        {!complete && <div className="verify-card-unchecked">{c.unchecked}: {(Object.hasOwn(errors, card.errorCode ?? "timeout") ? errors[card.errorCode ?? "timeout"] : errors.internal)[locale]}</div>}
        {details.length > 0 && <>
          <button type="button" className="verify-card-details-toggle" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(!detailsOpen)}>{c.details(details.length)}</button>
          {detailsOpen && <ul className="verify-card-details">{details.map((row, i) => <li key={`${row.checker}-${row.where}-${i}`}>{tile(row.tile)} · {row.where} · {row.measured}</li>)}</ul>}
        </>}
      </>}
      {(action === "rerun" || action === "watch") && <div className="verify-card-actions">
        {action === "rerun" && <button type="button" className="verify-card-rerun" onClick={rerun} disabled={pending}><RefreshCw size={13} className={pending ? "animate-spin" : undefined} />{c.rerun}</button>}
        {action === "watch" && <button type="button" data-verify-watch={action} aria-expanded={phone ? inline : undefined} onClick={watch}><Play size={13} />{c.watch}</button>}
      </div>}
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
