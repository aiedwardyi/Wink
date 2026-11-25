import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { aboutYouNote } from "../../shared/about-you-note";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { api } from "@/state/store";
import { DETAILS_INPUT, FitTextarea } from "./BotDetailsRows";
import { Fold } from "./Fold";
import { Card, ROW_BUTTON } from "./SettingsPrimitives";

type Source = { source: string; facts: string[] };
type Added = { source: string; added: number; found: number; hidden: number; flagged?: string[] };

const STEP = "flex items-center justify-between gap-4";
const STEP_TITLE = "text-[13px] font-medium text-ink";

/** The import prompt with its copy button, the same in Settings and a new chat's import card. */
export function ImportPromptBox({ className }: { className?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(t("aboutYou.prompt"));
      setCopied(true);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard permission can be denied; leave the button unchanged */
    }
  };

  return (
    <div className={cn("flex items-start gap-1 rounded-lg border border-hairline/40 bg-raised p-1.5", className)}>
      <div tabIndex={0} className="max-h-[129px] min-w-0 flex-1 overflow-hidden whitespace-pre-wrap py-0.5 pl-1.5 text-[13px] leading-relaxed text-ink-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
        {t("aboutYou.prompt")}
      </div>
      <button
        onClick={() => void copy()}
        aria-label={copied ? t("aboutYou.copied") : t("aboutYou.copy")}
        className="relative shrink-0 rounded p-1.5 text-ink-secondary hover:bg-raised-hover hover:text-ink [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-[7px] [@media(pointer:coarse)]:after:content-['']"
      >
        {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
      </button>
    </div>
  );
}

/** Lines of a paste that looked like passwords, left out of memory. They live only in this component:
 * Keep saves one as written, to wherever the paste went, and it leaves the list; leaving keeps the rest out. */
export function SkippedLines({ lines, keep, className }: { lines: string[]; keep: (line: string) => Promise<void>; className?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [kept, setKept] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const save = async (at: number) => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await keep(lines[at]!);
      setKept((before) => new Set(before).add(at));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  // a kept line is in memory now, so it no longer counts as skipped
  const left = lines.flatMap((line, at) => (kept.has(at) ? [] : [{ line, at }]));
  if (!left.length) return null;

  return (
    <div data-import-skipped className={className}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-fit items-center gap-1.5 text-left text-[12.5px] leading-5 text-ink-secondary hover:text-ink focus-visible:text-ink focus-visible:outline-none">
        {open ? <ChevronDown size={14} aria-hidden className="shrink-0" /> : <ChevronRight size={14} aria-hidden className="shrink-0" />}
        {left.length === 1 ? t("importCard.skippedOne") : t("importCard.skipped", { count: left.length })}
      </button>
      <Fold open={open}>
        <ul className="mt-1.5 flex flex-col gap-1.5">
          {left.map(({ line, at }) => (
            <li key={at} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 text-[13px] leading-5 text-ink [overflow-wrap:anywhere]">{line}</span>
              <button type="button" onClick={() => void save(at)} disabled={busy} className={cn(ROW_BUTTON, "text-ink")}>
                {t("importCard.keep")}
              </button>
            </li>
          ))}
        </ul>
        {failed && <div role="status" className="mt-1.5 text-[12.5px] text-ink">{t("aboutYou.failed")}</div>}
      </Fold>
    </div>
  );
}

/** Settings > About You: what the user's other AI knew about them, read by every bot. */
export function AboutYouCard() {
  const { t } = useI18n();
  const [sources, setSources] = useState<Source[] | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState("");
  // the last paste's password-looking lines, held here only; a new paste starts a new list
  const [skipped, setSkipped] = useState<{ id: number; lines: string[]; source: string } | null>(null);
  // only the newest request's list lands: an older answer would undo a newer change
  const listSeq = useRef(0);

  useEffect(() => {
    let gone = false;
    const seq = ++listSeq.current;
    void api("/api/about-you").then((body) => {
      if (!gone && seq === listSeq.current && Array.isArray(body?.sources)) setSources(body.sources);
    }).catch(() => {});
    return () => {
      gone = true;
    };
  }, []);

  const add = async () => {
    if (busy || !text.trim()) return;
    setBusy(true);
    const seq = ++listSeq.current;
    try {
      const body: Added & { sources: Source[] } = await api("/api/about-you", { method: "POST", body: JSON.stringify({ text }) });
      if (seq === listSeq.current) setSources(body.sources);
      setText("");
      setMore(false);
      setNote(aboutYouNote(body, t));
      setSkipped(body.flagged?.length ? { id: seq, lines: body.flagged, source: body.source } : null);
    } catch (error) {
      setNote((error as { status?: number }).status === 413 ? t("aboutYou.tooLarge") : t("aboutYou.failed"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (source: string) => {
    const seq = ++listSeq.current;
    try {
      const body = await api(`/api/about-you/sources/${encodeURIComponent(source)}`, { method: "DELETE" });
      if (seq === listSeq.current && Array.isArray(body?.sources)) setSources(body.sources);
      setNote("");
    } catch {
      setNote(t("aboutYou.failed"));
    }
  };

  const keep = async (line: string) => {
    const seq = ++listSeq.current;
    const body: Added & { sources: Source[] } = await api("/api/about-you", { method: "POST", body: JSON.stringify({ keep: [line], source: skipped!.source }) });
    if (seq === listSeq.current) setSources(body.sources);
  };

  const known = Boolean(sources?.length);
  const steps = (
    <div className="flex flex-col gap-6">
      <div>
        <div className={STEP_TITLE}>{t("aboutYou.step1")}</div>
        <ImportPromptBox className="mt-2" />
      </div>
      <div>
        <div className={STEP_TITLE}>{t("aboutYou.step2")}</div>
        <FitTextarea
          className={cn(DETAILS_INPUT, "mt-2 max-h-[240px] min-h-[76px] overflow-y-auto")}
          value={text}
          placeholder={t("aboutYou.placeholder")}
          aria-label={t("aboutYou.step2")}
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="mt-6 flex justify-end">
          <button onClick={() => void add()} disabled={busy || !text.trim()} className={cn(ROW_BUTTON, "text-ink")}>
            {t("aboutYou.add")}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <Card subtitle={known ? t("aboutYou.known") : t("aboutYou.empty")}>
      {note && <div role="status" className="mb-3 text-[13px] text-ink">{note}</div>}
      {skipped && <SkippedLines key={skipped.id} lines={skipped.lines} keep={keep} className="mb-3" />}
      {known ? (
        <>
          <div className="divide-y divide-hairline/40">
            {sources!.map(({ source, facts }) => (
              <div key={source} data-about-you-source={source} className="py-2.5 first:pt-0">
                <div className={STEP}>
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium text-ink">{source ? t("aboutYou.from", { source }) : t("aboutYou.byHand")}</div>
                    <div className="text-[12px] text-ink-secondary">{facts.length === 1 ? t("aboutYou.factOne") : t("aboutYou.facts", { count: facts.length })}</div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button onClick={() => setOpen(open === source ? null : source)} aria-expanded={open === source} className={cn(ROW_BUTTON, "text-ink")}>
                      {open === source ? t("aboutYou.hide") : t("aboutYou.view")}
                    </button>
                    <button onClick={() => void remove(source)} className={cn(ROW_BUTTON, "text-ink")}>{t("aboutYou.remove")}</button>
                  </div>
                </div>
                <Fold open={open === source}>
                  <ul className="mt-2 flex flex-col gap-1 text-[13px] leading-relaxed text-ink">
                    {facts.map((fact, index) => <li key={index}>{fact}</li>)}
                  </ul>
                </Fold>
              </div>
            ))}
          </div>
          <div className="mt-3 border-t border-hairline/40 pt-3">
            <button onClick={() => setMore(!more)} aria-expanded={more} className={cn(ROW_BUTTON, "text-ink")}>{t("aboutYou.addMore")}</button>
            <Fold open={more}>
              <div className="pt-3">{steps}</div>
            </Fold>
          </div>
        </>
      ) : (
        <div className="pt-2">{steps}</div>
      )}
    </Card>
  );
}
