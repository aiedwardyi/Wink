import { useState, type CSSProperties } from "react";
import { FileCheck, Play } from "lucide-react";
import { LIVE_VERIFY_V0, verifyCardStale, type VerifyCardData } from "../../shared/live-verify";
import { VERIFY_DOC_KINDS, type VerifyDocFinding, type VerifyDocKind } from "../../shared/verify-doc";
import { useI18n } from "@/lib/i18n";
import { lazyView } from "@/lib/stale-build";
import { useIsPhone } from "@/lib/use-phone-swipe";
import { openVerifyWatch } from "@/lib/verify-watch";
import { Fold } from "./Fold";
import { LazyView } from "./LazyView";
import "./VerifyDoc.css";

const VerifyDocWatchFrame = lazyView(() => import("./VerifyDocWatch").then(m => ({ default: m.VerifyDocWatchFrame })));

export const DOC_ROLE: Record<VerifyDocKind, string> = { spelling: "#6aa9d8", grammar: "#8c95dc", translation: "#5eb5a6", names: "#8db88a", numbering: "#94a3b8" };

export const docCopy = {
  en: { kinds: { spelling: "Spelling", grammar: "Grammar", translation: "Translation", names: "Names and dates", numbering: "Numbering" }, words: { spelling: "spelling", grammar: "grammar", translation: "translation", names: "names and dates", numbering: "numbering" }, checking: (page: number, pages: number) => `Checking page ${page} of ${pages}`, comparing: "Comparing names and dates", problems: (n: number) => `${n} ${n === 1 ? "problem" : "problems"}`, clean: "No problems", fixed: (n: number) => `Fixed ${n} ${n === 1 ? "problem" : "problems"}`, pages: (n: number) => `${n} ${n === 1 ? "page" : "pages"}`, s: " s", at: (f: VerifyDocFinding) => `p.${f.page} · line ${f.line}`, showAll: (n: number) => `Show all ${n}`, fixing: " · bot is fixing", left: (n: number) => `${n} left`, details: "Show details", changed: "Fixed", kept: "Left", watch: "Watch", failed: "Could not check this document", unchecked: "Not checked", pageList: (ranges: string) => `pages ${ranges}`, cut: (n: number) => `the last ${n.toLocaleString("en")} characters, over the size limit`, reasons: { timeout: "check took too long", cancelled: "check was stopped", internal: "check could not finish" } as Record<string, string> },
  ko: { kinds: { spelling: "맞춤법", grammar: "문법", translation: "번역 짝", names: "이름·날짜", numbering: "번호·참조" }, words: { spelling: "맞춤법", grammar: "문법", translation: "번역 짝", names: "이름·날짜", numbering: "번호·참조" }, checking: (page: number, pages: number) => `${pages}쪽 중 ${page}쪽 확인 중`, comparing: "이름·날짜 비교 중", problems: (n: number) => `문제 ${n}개`, clean: "문제 없음", fixed: (n: number) => `문제 ${n}개 해결`, pages: (n: number) => `${n}쪽`, s: "초", at: (f: VerifyDocFinding) => `${f.page}쪽 · ${f.line}줄`, showAll: (n: number) => `${n}개 모두 보기`, fixing: " · 봇이 수정 중", left: (n: number) => `${n}개 남음`, details: "자세히 보기", changed: "해결", kept: "남은 문제", watch: "보기", failed: "문서를 확인하지 못했어요", unchecked: "확인하지 못함", pageList: (ranges: string) => `${ranges}쪽`, cut: (n: number) => `크기 한도를 넘은 마지막 ${n.toLocaleString("ko")}자`, reasons: { timeout: "확인 시간이 초과됐어요", cancelled: "확인이 중단됐어요", internal: "확인을 마치지 못했어요" } as Record<string, string> },
};

const SHOWN = 5;

export function VerifyDocCard({ card, threadId, messageId }: { card: VerifyCardData; threadId: string; messageId?: string }) {
  const { locale } = useI18n();
  const c = docCopy[locale];
  const phone = useIsPhone();
  const [all, setAll] = useState(false);
  const [details, setDetails] = useState(false);
  const [inline, setInline] = useState<boolean | null>(null);
  if (!LIVE_VERIFY_V0 || !card.doc) return null;
  const doc = card.doc;
  const stale = verifyCardStale(card, Date.now());
  const running = !stale && (card.status === "preparing" || card.status === "running");
  const complete = !stale && card.status === "completed";
  const findings = doc.findings ?? [], fixedRows = doc.fixedFindings ?? [];
  const total = Math.max(doc.findingTotal ?? 0, findings.length);
  const [done, chunks] = doc.chunks;
  // A doc check streams from its first moment; the stored card never carries the live flag its patches do.
  const action = running ? "live" : card.replay?.length ? "watch" : null;
  const seconds = `${Math.max(0, Math.round(((card.endedAt ?? Date.now()) - (card.startedAt ?? card.offeredAt)) / 1000))}${c.s}`;
  const progress = done >= chunks ? c.comparing : c.checking(doc.page ?? 1, doc.pages);
  const result = `${card.fixed ? total ? `${c.fixed(card.fixed)} · ${c.left(total)}` : c.fixed(card.fixed) : total ? c.problems(total) : c.clean}${doc.fixing ? c.fixing : ""}`;
  const title = running ? progress : !complete ? c.failed : `${result} · ${c.pages(doc.pages)} · ${seconds}`;
  const watch = () => {
    if (phone) setInline(inline === null ? action === "live" : null);
    else openVerifyWatch({ threadId, owner: card.owner, messageId, live: action === "live" });
  };
  const finding = (f: VerifyDocFinding, i: number) => <li key={`${f.kind}-${f.line}-${i}`} style={{ "--role": DOC_ROLE[f.kind] } as CSSProperties}>
    <span className="verify-doc-kind"><i />{c.kinds[f.kind]}</span>
    <span className="verify-doc-at">{c.at(f)}</span>
    <span className="verify-doc-text"><q>{f.quote}</q>{f.fix && <> → <b>{f.fix}</b></>}{f.note && <small>{f.note}</small>}</span>
  </li>;
  const reason = stale ? c.reasons.internal : c.reasons[card.errorCode ?? "internal"] ?? c.reasons.internal;
  return (
    <section className="verify-card verify-doc" data-active={running || undefined} aria-label={title} data-verify-card>
      <div className="verify-card-head" role="status" aria-live="polite">
        <FileCheck size={14} />
        <span className="verify-card-title">Live Verify · {card.site}</span>
        <span className="verify-card-side">
          {action && <button type="button" data-verify-watch={action} aria-expanded={phone ? inline !== null : undefined} onClick={watch}>{action === "watch" && <Play size={13} />}{c.watch}</button>}
        </span>
      </div>
      <Fold open={running} keep>
        <ul className="verify-doc-kinds">{VERIFY_DOC_KINDS.map(kind => {
          const n = doc.by?.[kind] ?? 0;
          return <li key={kind} data-state={done < chunks || kind === "names" ? "running" : "done"} style={{ "--role": DOC_ROLE[kind] } as CSSProperties}>
            <i /><span>{c.kinds[kind]}</span><b data-issues={n > 0 || undefined}>{n}</b>
          </li>;
        })}</ul>
        <div className="verify-doc-bar" aria-hidden="true"><i style={{ width: `${chunks ? Math.min(100, done / chunks * 100) : 0}%` }} /></div>
        <div className="verify-doc-progress">{progress}</div>
      </Fold>
      <Fold open={!running} keep>
        <div className="verify-card-strip">{title}</div>
        {card.fixed ? (findings.length > 0 || fixedRows.length > 0) && <>
          <Fold open={details}>
            {fixedRows.length > 0 && <><div className="verify-doc-group">{c.changed}</div><ol className="verify-doc-findings" data-fixed>{fixedRows.map(finding)}</ol></>}
            {findings.length > 0 && <><div className="verify-doc-group">{c.kept}</div><ol className="verify-doc-findings">{findings.map(finding)}</ol></>}
          </Fold>
          <Fold open={!details}><button type="button" className="verify-card-more" onClick={() => setDetails(true)}>{c.details}</button></Fold>
        </> : findings.length > 0 && <ol className="verify-doc-findings">{findings.slice(0, SHOWN).map(finding)}</ol>}
        {!card.fixed && findings.length > SHOWN && <>
          <Fold open={all}><ol className="verify-doc-findings verify-doc-findings-rest">{findings.slice(SHOWN).map((f, i) => finding(f, i + SHOWN))}</ol></Fold>
          <Fold open={!all}><button type="button" className="verify-card-more" onClick={() => setAll(true)}>{c.showAll(findings.length)}</button></Fold>
        </>}
        {card.notChecked?.length ? <div className="verify-card-unchecked">{c.unchecked}: {c.pageList(card.notChecked.join(", "))}</div> : null}
        {doc.cut ? <div className="verify-card-unchecked">{c.unchecked}: {c.cut(doc.cut)}</div> : null}
        {doc.uncompared ? <div className="verify-card-unchecked">{c.unchecked}: {c.words.names}</div> : null}
        {!complete && <div className="verify-card-unchecked">{c.unchecked}: {reason}</div>}
      </Fold>
      {phone && inline !== null && <LazyView><VerifyDocWatchFrame card={card} threadId={threadId} live={inline} hidden={false} inline onClose={() => setInline(null)} /></LazyView>}
    </section>
  );
}
