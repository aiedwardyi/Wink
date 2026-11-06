import { useState } from "react";
import { AlertTriangle, Check, Loader2, Monitor, RefreshCw, Smartphone } from "lucide-react";
import { LIVE_VERIFY_V0, VERIFY_ROUTES, verifyCardStale, type VerifyCardData } from "../../shared/live-verify";
import { request } from "@/lib/api-request";
import { useI18n } from "@/lib/i18n";
import "./VerifyCard.css";

const copy = {
  en: { running: "Checking in a real browser", stages: ["Loads", "Links", "Phone"], clean: "Desktop and phone · no problems", problems: (n: number) => `${n} ${n === 1 ? "problem" : "problems"} · bot is fixing`, unchecked: "Not checked", delivery: "form delivery", rerun: "Rerun", failed: "Could not check this page", retry: "Could not rerun. Try again.", desktop: "Desktop", phone: "Phone" },
  ko: { running: "실제 브라우저에서 확인 중", stages: ["페이지 로드", "링크", "휴대폰"], clean: "데스크톱과 휴대폰 · 문제 없음", problems: (n: number) => `문제 ${n}개 · 봇이 수정 중`, unchecked: "확인하지 못함", delivery: "폼 전송", rerun: "다시 확인", failed: "페이지를 확인하지 못했어요", retry: "다시 확인하지 못했어요. 다시 시도하세요.", desktop: "데스크톱", phone: "휴대폰" },
};

const coverageKo: Record<string, string> = {
  "form delivery": "폼 전송", "images not loaded": "로드되지 않은 이미지", "external links": "외부 링크",
  fonts: "글꼴", "page errors": "페이지 오류", links: "링크", "phone sideways scroll": "휴대폰 가로 스크롤", "phone menu": "휴대폰 메뉴", leftovers: "남은 임시 문구",
  "phone menu (desktop navigation unavailable)": "휴대폰 메뉴 (데스크톱 탐색을 확인하지 못함)",
};

const blockedKo: Record<string, string> = { code: "의 코드가", requests: "로 가는 요청이", styles: "의 스타일이" };

export function VerifyCard({ card, threadId }: { card: VerifyCardData; threadId: string }) {
  const { locale } = useI18n();
  const c = copy[locale];
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  if (!LIVE_VERIFY_V0) return null;
  const stale = verifyCardStale(card, Date.now());
  const running = !stale && (card.status === "preparing" || card.status === "running");
  const complete = card.status === "completed";
  const issues = card.issues ?? [];
  const seconds = Math.max(0, Math.round(((card.endedAt ?? Date.now()) - (card.startedAt ?? card.offeredAt)) / 1000));
  const title = running ? c.running : complete ? issues.length ? c.problems(issues.length) : `${c.clean} · ${seconds}${locale === "ko" ? "초" : " s"}` : c.failed;
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
    try {
      await request(VERIFY_ROUTES.decision.replace(":runId", encodeURIComponent(card.runId)), { method: "POST", body: JSON.stringify({ action: "rerun", nonce: card.decisionNonce, owner: card.owner, threadId }) });
    } catch { setError(true); }
    finally { setPending(false); }
  };
  return (
    <section className="verify-card" aria-label={title} data-verify-card>
      <div className="verify-card-heading" role="status" aria-live="polite">
        {running ? <Loader2 size={17} className="animate-spin" /> : complete && !issues.length ? <Check size={17} /> : <AlertTriangle size={17} />}
        <strong>{title}</strong>
      </div>
      <div className="verify-card-site">{card.site}</div>
      {running ? <div className="verify-card-stages">{c.stages.map(stage => <span key={stage}>{stage}</span>)}</div> : <>
        {issues.length > 0 && <ul className="verify-card-problems">{issues.map((issue, i) => <li key={`${issue.checker}-${issue.where}-${i}`}>
          <div className="verify-card-location">{issue.tile === "phone" ? <Smartphone size={14} /> : <Monitor size={14} />}<span>{issue.tile === "phone" ? c.phone : c.desktop} · {issue.where}</span></div>
          <div>{issue.measured}</div>
        </li>)}</ul>}
        {(card.notChecked ?? []).map(reason => <div className="verify-card-unchecked" key={reason}>{c.unchecked}: {coverage(reason)}</div>)}
        {!complete && <div className="verify-card-unchecked">{c.unchecked}: {card.errorCode ?? "timeout"}</div>}
      </>}
      <div className="verify-card-actions">{!running && <button type="button" onClick={rerun} disabled={pending}><RefreshCw size={13} className={pending ? "animate-spin" : undefined} />{c.rerun}</button>}</div>
      {error && <div role="alert" className="verify-card-unchecked">{c.retry}</div>}
    </section>
  );
}
