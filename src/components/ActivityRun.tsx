// A folded stretch of tool chips: one row saying what ran, click to open.
//
// Collapsed by default. A run stays open once you open it, and search can
// force it open so a hit is not stuck behind the fold. A failure shows as a
// quiet cross beside the summary; the row itself never goes red.
import { Fragment, memo, useEffect, useState } from "react";
import { Bot, ChevronDown, Check, FileText, Globe, Loader2, Pencil, Search, SquareTerminal, Wrench, X } from "lucide-react";
import type { Message } from "@/state/store";
import { classifyServerNotice, describeRun, isCommsNotice, describeSearch, localizeServerLine, sameNotices, type LinkedApproval } from "@/lib/activity-runs";
import { useI18n, type Translate } from "@/lib/i18n";
import { isTerminalToolSkin, useSkin } from "@/lib/skins";
import { APPROVAL_WORD, TERM_STEP_WORD, termBlock, termHeaderArgs, termResultLine, termStepAria, termStepState, termUpdatedLine, termVerb } from "@/lib/terminal-skin";
import "./ActivityRun.css";
import { Fold } from "./Fold";

function StepStatus({ ok }: { ok: boolean | undefined }) {
  if (ok === undefined) return <Loader2 data-idle-hide size={13} className="shrink-0 animate-spin" />;
  if (ok === false) return <X size={13} strokeWidth={1.5} className="shrink-0" />;
  return <Check size={13} className="shrink-0 text-success" />;
}

function stepIcon(name: string) {
  if (name === "Read") return FileText;
  if (name === "Edit" || name === "Write" || name === "NotebookEdit") return Pencil;
  if (name === "Bash") return SquareTerminal;
  if (name === "Grep" || name === "Glob") return Search;
  if (name === "WebFetch" || name === "WebSearch") return Globe;
  if (name === "Agent" || name === "Task") return Bot;
  return Wrench;
}

const formatDuration = (ms: number) =>
  ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;

export function approvalHover(notices: LinkedApproval[] | undefined, t: Translate): string | undefined {
  if (!notices?.length) return undefined;
  return notices.map((notice) => t(APPROVAL_WORD[notice.label])).join(" · ");
}

export function CommsNotice({ text }: { text: string }) {
  return text.split(/(?<=\.) /).map((sentence, index) => (
    <Fragment key={index}>{index > 0 && " "}<span className="inline-block whitespace-nowrap">{sentence}</span></Fragment>
  ));
}

function TermNotice({ text, failed, comms = false }: { text: string; failed: boolean; comms?: boolean }) {
  return <div className="term-notice" data-term-notice={failed ? "failed" : "ok"} style={comms ? { textWrap: "balance", wordBreak: "keep-all" } : undefined}>{comms ? <CommsNotice text={text} /> : text}</div>;
}

/** One step inside an open run. A running step ticks its elapsed time, then
 * settles in the same row: same key, same element, only the status swaps. */
export const ActivityStep = memo(function ActivityStep({ message, notices }: { message: Message; notices?: LinkedApproval[] }) {
  const { t } = useI18n();
  const terminal = isTerminalToolSkin(useSkin());
  const tool = message.tool;
  const comms = tool ? isCommsNotice(tool.name) : false;
  const running = tool?.ok === undefined && !comms;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [running]);
  if (!tool) return null;
  if (terminal && comms) return <TermNotice text={localizeServerLine(tool.name, t)} failed={false} comms />;
  const notice = classifyServerNotice(tool.name);
  if (terminal && notice) {
    if (notice.kind === "approval" && notice.label !== "review" && tool.ok !== false) return null;
    const text = notice.kind === "approval" ? t(APPROVAL_WORD[notice.label]) : tool.name;
    return <TermNotice text={text} failed={tool.ok === false} />;
  }
  const Icon = stepIcon(tool.name);
  const elapsed = running ? Math.max(0, now - new Date(message.at).getTime()) : tool.durationMs;
  const shown = localizeServerLine(tool.name, t);
  if (terminal) return <TermStep name={shown} rawVerb={tool.verb} summary={tool.summary} ok={tool.ok} elapsed={elapsed} detail={tool.detail} notices={notices} />;
  return (
    <div title={approvalHover(notices, t)} className="flex max-w-[min(42rem,100%)] items-center gap-2 px-3 py-0.5 text-[13px] text-ink-secondary">
      <Icon size={13} className="shrink-0" />
      <span className="shrink-0 text-ink">{shown}</span>
      {tool.summary && <span className="min-w-0 truncate font-mono text-[12px]">{tool.summary}</span>}
      <StepStatus ok={tool.ok} />
      <span className="ml-auto shrink-0 pl-3 text-[12px] tabular-nums">{elapsed === undefined ? "" : formatDuration(elapsed)}</span>
    </div>
  );
}, (a, b) => a.message === b.message && sameNotices(a.notices, b.notices));

type ToolDetail = NonNullable<Message["tool"]>["detail"];

/** Expands only the captured preview; discarded output cannot be recovered. */
function TermStep({ name, rawVerb, summary, ok, elapsed, detail, notices }: { name: string; rawVerb?: string; summary?: string; ok: boolean | undefined; elapsed: number | undefined; detail?: ToolDetail; notices?: LinkedApproval[] }) {
  const { t } = useI18n();
  const verb = termVerb(rawVerb ?? name).replace(/ \(MCP\)$/, "");
  const state = termStepState(ok);
  const aria = termStepAria(state, elapsed);
  const args = termHeaderArgs(verb, summary, detail, rawVerb ? name : undefined);
  const block = termBlock(detail, state === "failed");
  const call = [
    rawVerb && name !== rawVerb && name !== args && name !== summary ? name : undefined,
    summary && summary !== args ? summary : undefined,
    detail?.input && detail.input !== args ? detail.input : undefined,
  ].filter(Boolean);
  return (
    <div data-term-step={state} className="term-step min-w-0 max-w-full">
      <details>
        <summary className="term-step-head" aria-label={t(aria.key, { tool: args ? `${verb}(${args})` : verb, seconds: aria.seconds ?? 0 })} title={t("term.step.expand")}>
          <span className="font-semibold text-ink">{verb}</span>
          {args && `(${args})`}
        </summary>
        {call.length > 0 && <div data-term-call>{call.map((line, index) => <div key={index}>{line}</div>)}</div>}
      </details>
      {block?.kind === "hidden" ? (
        <div className="term-step-out">{t("term.step.hidden")}</div>
      ) : block ? (
        <div className="term-step-out">
          {block.changes && detail?.input && <div data-term-changes>{termUpdatedLine(t, detail.input, block.changes)}</div>}
          {block.rows.map((row, index) => <div key={index} data-term-row={row.tone}>{row.text}</div>)}
          {block.more && <div>{t(block.more === 1 ? "term.step.moreOne" : "term.step.moreMany", { count: block.more })}</div>}
        </div>
      ) : (
        <div className="term-step-result truncate">{termResultLine(t(TERM_STEP_WORD[state]), undefined)}</div>
      )}
      {notices?.filter((notice) => notice.label === "review" || notice.message.tool?.ok === false).map((notice) => <TermNotice key={notice.message.id} text={t(APPROVAL_WORD[notice.label])} failed={notice.message.tool?.ok === false} />)}
    </div>
  );
}

export function ActivityRun({
  messages,
  forceOpen = false,
  children,
}: {
  messages: Message[];
  /** landing on a step inside this run — a search hit cannot scroll to a
   * row that a fold has kept out of the DOM */
  forceOpen?: boolean;
  /** the individual chips, rendered by whichever transcript owns them */
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const terminal = isTerminalToolSkin(useSkin());
  const failed = messages.some((message) => message.tool?.ok === false);
  const running = messages.some((message) => message.tool?.ok === undefined);
  const [open, setOpen] = useState(forceOpen);
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);
  if (terminal) {
    return (
      <div className="flex flex-col">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="term-search self-start text-left">
          {describeSearch(messages, t)}
          {running && <span> · {t("task.running")}</span>}
          {failed && <span> · {t("workers.failed")}</span>}
        </button>
        <Fold open={open}>
          <div className="flex flex-col">{children}</div>
        </Fold>
      </div>
    );
  }
  return (
    <div className="flex flex-col">
      <div className="flex justify-start">
        {open ? (
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-expanded
            className="flex items-center gap-2 rounded-lg border border-transparent px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-control focus-visible:bg-control"
          >
            <ChevronDown size={13} className="rotate-180" />
            <span>{describeRun(messages, t)}<span data-idle-hide={running ? "" : undefined}> ·</span></span>
            <StepStatus ok={running ? undefined : !failed} />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-expanded={false}
            title={t("activity.showEveryStep")}
            className="flex items-center gap-2 rounded-lg border border-transparent px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-control focus-visible:bg-control"
          >
            <span className="max-w-[480px] truncate">{describeRun(messages, t)}<span data-idle-hide={running ? "" : undefined}> ·</span></span>
            <StepStatus ok={running ? undefined : !failed} />
            <ChevronDown size={13} />
          </button>
        )}
      </div>
      <Fold open={open}>
        <div className="flex flex-col gap-1 pt-1">{children}</div>
      </Fold>
    </div>
  );
}
