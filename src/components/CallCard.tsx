import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Phone } from "lucide-react";

import { isVoiceLine } from "../../shared/live-call";
import { cn } from "@/lib/cn";
import { localeTag, useI18n } from "@/lib/i18n";
import { callLength, callStripe, callSummary } from "@/lib/live-call/call-card";
import { formatTime, type Message } from "@/state/store";
import { Fold } from "./Fold";

/** One call in the chat: the "Call · time" line while you talk, then a card with its length, summary, voice stripe and transcript. */
export function CallCard({ rows, live, botName, forceOpen = false }: { rows: Message[]; live: boolean; botName: string; forceOpen?: boolean }) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(forceOpen);
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);
  const first = rows[0]!;
  const time = formatTime(first.at, localeTag(locale));
  const said = useMemo(() => rows.filter((row) => isVoiceLine(row) && row.text?.trim()), [rows]);
  const stripe = useMemo(() => callStripe(rows), [rows]);
  const summary = callSummary(rows);
  const [shownFirst] = useState(summary);
  const ms = first.call?.ms ?? (said.length ? said.at(-1)!.at - said[0]!.at : 0);
  return (
    <>
      <Fold open={live} soft>
        <div className="py-3 text-center text-[13px] text-ink-secondary">{t("chat.callDivider", { time })}</div>
      </Fold>
      <Fold open={!live} soft>
        <div data-call-card className="flex w-full flex-col items-start pb-4">
          <div className="w-full max-w-[min(26rem,78%)] rounded-2xl bg-card px-4 py-2.5 text-ink">
            <div className="flex items-center gap-1.5 text-[13px]">
              <Phone size={13} className="shrink-0 text-ink-secondary" />
              <span className="font-medium">{t("chat.callLength", { length: callLength(ms) })}</span>
              <span className="ml-auto shrink-0 text-[12px] text-ink-secondary">{time}</span>
            </div>
            {stripe.length > 0 && (
              <div data-call-stripe aria-hidden="true" className="mt-2 flex h-5 items-center gap-[2px]">
                {stripe.map((bar, i) => (
                  <span
                    key={i}
                    className={cn("min-w-px max-w-1 flex-1 rounded-full", bar.who === "voice" ? "bg-accent" : bar.who === "user" ? "bg-ink-secondary/70" : "bg-control")}
                    style={{ height: `${Math.round(bar.height * 100)}%` }}
                  />
                ))}
              </div>
            )}
            <p key={summary} className={cn("mt-2 line-clamp-2 min-h-[2lh] text-[14px] leading-snug", summary !== shownFirst && "animate-fade-in")}>{summary}</p>
            {said.length > 0 && (
              <button
                type="button"
                onClick={() => setOpen((value) => !value)}
                aria-expanded={open}
                className="mt-1 -ml-1 flex items-center gap-1 rounded px-1 py-0.5 text-[12.5px] text-ink-secondary hover:bg-raised/50 hover:text-ink"
              >
                {t(open ? "chat.callHideTranscript" : "chat.callShowTranscript")}
                <ChevronDown size={13} className={cn("transition-transform", open && "rotate-180")} />
              </button>
            )}
            <Fold open={open} soft>
              <ol className="mt-1.5 space-y-1.5 pb-1 text-[13px] leading-snug">
                {said.map((row) => (
                  <li key={row.id}>
                    <div className="contents" data-mid={row.id}>
                      <div className="flex gap-2">
                        <span className="w-14 shrink-0 truncate text-ink-secondary">{row.role === "user" ? t("chat.you") : botName}</span>
                        <span className="min-w-0 flex-1 break-words">{row.text}</span>
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            </Fold>
          </div>
        </div>
      </Fold>
    </>
  );
}
