// A shared group's invite code and what it lets people do, for Members and People alike.
import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

import { useI18n } from "@/lib/i18n";

/** Shows `short` when the relay minted one, else the long code. */
export function RoomCode({ code, short }: { code: string; short?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const resetTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
  }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(short ?? code);
      setCopyFailed(false);
      setCopied(true);
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), 1_200);
    } catch {
      setCopyFailed(true);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <div data-team-room-code className="flex items-center gap-3 rounded-lg bg-inset px-3 py-2">
        <span className="shrink-0 text-[13px] font-medium text-ink">{t("teamRoom.inviteCode")}</span>
        {short
          ? <span data-room-code-text className="min-w-0 flex-1 select-all truncate text-right font-mono text-[15px] tracking-[0.2em] text-ink">{short}</span>
          : <span data-room-code-text className={`min-w-0 flex-1 select-all font-mono text-[11.5px] text-ink-secondary ${copyFailed ? "break-all" : "truncate text-right"}`}>{code}</span>}
        <button
          type="button"
          onClick={() => void copy()}
          className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-accent-text hover:bg-control"
        >
          {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
          {copied ? t("teamRoom.copied") : t("teamRoom.copy")}
        </button>
      </div>
      <p data-room-code-hint className="px-3 text-[12px] text-ink-secondary">{t(short ? "teamRoom.shortCodeHint" : "teamRoom.codeHint")}</p>
    </div>
  );
}
