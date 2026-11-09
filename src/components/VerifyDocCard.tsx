import { useState, type CSSProperties } from "react";
import { FileCheck, Play, Send } from "lucide-react";
import { LIVE_VERIFY_V0, verifyCardStale, type VerifyCardData } from "../../shared/live-verify";
import { VERIFY_DOC_KINDS, type VerifyDocFinding, type VerifyDocKind } from "../../shared/verify-doc";
import { useI18n } from "@/lib/i18n";
import { lazyView } from "@/lib/stale-build";
import { useIsPhone } from "@/lib/use-phone-swipe";
import { openVerifyWatch } from "@/lib/verify-watch";
import { useStore } from "@/state/store";
import { Fold } from "./Fold";
import { LazyView } from "./LazyView";
import "./VerifyDoc.css";

const VerifyDocWatchFrame = lazyView(() => import("./VerifyDocWatch").then(m => ({ default: m.VerifyDocWatchFrame })));

export const DOC_ROLE: Record<VerifyDocKind, string> = { spelling: "#6aa9d8", grammar: "#8c95dc", translation: "#5eb5a6", names: "#8db88a", numbering: "#94a3b8" };

export const docCopy = {
  en: { kinds: { spelling: "Spelling", grammar: "Grammar", translation: "Translation", names: "Names and dates", numbering: "Numbering" }, words: { spelling: "spelling", grammar: "grammar", translation: "translation", names: "names and dates", numbering: "numbering" }, checking: (page: number, pages: number) => `Checking page ${page} of ${pages}`, comparing: "Comparing names and dates", problems: (n: number) => `${n} ${n === 1 ? "problem" : "problems"}`, clean: "No problems", fixed: (n: number) => `Fixed ${n} ${n === 1 ? "problem" : "problems"}`, pages: (n: number) => `${n} ${n === 1 ? "page" : "pages"}`, s: " s", at: (f: VerifyDocFinding) => `p.${f.page} · line ${f.line}`, showAll: (n: number) => `Show all ${n}`, fix: "Fix these", sent: "Sent to the bot", watch: "Watch", failed: "Could not check this document", unchecked: "Not checked", pageList: (ranges: string) => `pages ${ranges}`, cut: (n: number) => `the last ${n.toLocaleString("en")} characters, over the size limit`, reasons: { timeout: "check took too long", cancelled: "check was stopped", internal: "check could not finish" } as Record<string, string>, ask: (site: string) => `Please fix these problems Live Verify found in ${site}:`, line: (f: VerifyDocFinding) => `Page ${f.page}, line ${f.line}`, more: (n: number) => `…and ${n} more` },
  ko: { kinds: { spelling: "맞춤법", grammar: "문법", translation: "번역 짝", names: "이름·날짜", numbering: "번호·참조" }, words: { spelling: "맞춤법", grammar: "문법", translation: "번역 짝", names: "이름·날짜", numbering: "번호·참조" }, checking: (page: number, pages: number) => `${pages}쪽 중 ${page}쪽 확인 중`, comparing: "이름·날짜 비교 중", problems: (n: number) => `문제 ${n}개`, clean: "문제 없음", fixed: (n: number) => `문제 ${n}개 해결`, pages: (n: number) => `${n}쪽`, s: "초", at: (f: VerifyDocFinding) => `${f.page}쪽 · ${f.line}줄`, showAll: (n: number) => `${n}개 모두 보기`, fix: "수정 요청", sent: "봇에게 보냈어요", watch: "보기", failed: "문서를 확인하지 못했어요", unchecked: "확인하지 못함", pageList: (ranges: string) => `${ranges}쪽`, cut: (n: number) => `크기 한도를 넘은 마지막 ${n.toLocaleString("ko")}자`, reasons: { timeout: "확인 시간이 초과됐어요", cancelled: "확인이 중단됐어요", internal: "확인을 마치지 못했어요" } as Record<string, string>, ask: (site: string) => `Live Verify가 ${site}에서 찾은 문제를 고쳐 주세요:`, line: (f: VerifyDocFinding) => `${f.page}쪽 ${f.line}줄`, more: (n: number) => `…외 ${n}개` },
};

const SHOWN = 5;
const FIX_CHARS = 4_000;
const flat = (text: string) => text.replace(/\s+/g, " ");

/** The findings as the user's own message to the bot; a room needs the bot's @name. */
export function fixTheseText(card: VerifyCardData, locale: "en" | "ko", mention?: string): string {
  const c = docCopy[locale], findings = card.doc?.findings ?? [];
  const total = Math.max(card.doc?.findingTotal ?? 0, findings.length);
  let text = `${mention ? `@${mention} ` : ""}${c.ask(card.site)}`, listed = 0;
  for (const f of findings) {
    const row = `\n${listed + 1}. ${c.line(f)} (${c.words[f.kind]}): "${flat(f.quote)}"${f.fix ? ` → "${flat(f.fix)}"${f.note ? ` (${flat(f.note)})` : ""}` : f.note ? ` - ${flat(f.note)}` : ""}`;
    if (text.length + row.length + 24 > FIX_CHARS) break;
    text += row; listed++;
  }
  return listed < total ? `${text}\n${c.more(total - listed)}` : text;
}

export function VerifyDocCard({ card, threadId, messageId }: { card: VerifyCardData; threadId: string; messageId?: string }) {
  const { locale } = useI18n();
  const c = docCopy[locale];
  const { state, dispatch } = useStore();
  const phone = useIsPhone();
  const [all, setAll] = useState(false);
  const [sent, setSent] = useState(false);
  const [inline, setInline] = useState<boolean | null>(null);
  if (!LIVE_VERIFY_V0 || !card.doc) return null;
  const doc = card.doc;
  const stale = verifyCardStale(card, Date.now());
  const running = !stale && (card.status === "preparing" || card.status === "running");
  const complete = !stale && card.status === "completed";
  const findings = doc.findings ?? [];
  const total = Math.max(doc.findingTotal ?? 0, findings.length);
  const [done, chunks] = doc.chunks;
  // A doc check streams from its first moment; the stored card never carries the live flag its patches do.
  const action = running ? "live" : card.replay?.length ? "watch" : null;
  const seconds = `${Math.max(0, Math.round(((card.endedAt ?? Date.now()) - (card.startedAt ?? card.offeredAt)) / 1000))}${c.s}`;
  const progress = done >= chunks ? c.comparing : c.checking(doc.page ?? 1, doc.pages);
  const title = running ? progress : !complete ? c.failed : `${total ? c.problems(total) : card.fixed ? c.fixed(card.fixed) : c.clean} · ${c.pages(doc.pages)} · ${seconds}`;
  const room = state.groups.find(group => group.threadId === threadId || group.tasks?.some(task => task.threadId === threadId));
  // Sent is per device; a newer check of the same file is what retires this card's findings everywhere.
  const thread = state.bots.find(bot => bot.threadId === threadId)?.messages ?? state.groups.find(group => group.threadId === threadId)?.messages ?? [];
  const replaced = thread.some(m => m.verify?.doc && m.verify.site === card.site && m.verify.runId !== card.runId && m.verify.offeredAt > card.offeredAt);
  const fix = () => {
    if (room) dispatch({ type: "sendGroup", groupId: room.id, threadId, text: fixTheseText(card, locale, state.bots.find(bot => bot.id === card.owner)?.name) });
    else dispatch({ type: "send", botId: card.owner, threadId, text: fixTheseText(card, locale) });
    setSent(true);
  };
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
        {findings.length > 0 && <ol className="verify-doc-findings">{findings.slice(0, SHOWN).map(finding)}</ol>}
        {findings.length > SHOWN && <>
          <Fold open={all}><ol className="verify-doc-findings verify-doc-findings-rest">{findings.slice(SHOWN).map((f, i) => finding(f, i + SHOWN))}</ol></Fold>
          <Fold open={!all}><button type="button" className="verify-card-more" onClick={() => setAll(true)}>{c.showAll(findings.length)}</button></Fold>
        </>}
        {card.notChecked?.length ? <div className="verify-card-unchecked">{c.unchecked}: {c.pageList(card.notChecked.join(", "))}</div> : null}
        {doc.cut ? <div className="verify-card-unchecked">{c.unchecked}: {c.cut(doc.cut)}</div> : null}
        {!complete && <div className="verify-card-unchecked">{c.unchecked}: {reason}</div>}
        {complete && findings.length > 0 && !replaced && <div className="verify-doc-actions">
          {sent ? <span role="status">{c.sent}</span> : <button type="button" onClick={fix}><Send size={13} />{c.fix}</button>}
        </div>}
      </Fold>
      {phone && inline !== null && <LazyView><VerifyDocWatchFrame card={card} threadId={threadId} live={inline} hidden={false} inline onClose={() => setInline(null)} /></LazyView>}
    </section>
  );
}
