// A team room's notice: one line at the top, tap to jump, chevron to expand.
import { useState } from "react";
import { ChevronDown, ChevronUp, Megaphone } from "lucide-react";

import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import type { RoomLine } from "@/lib/team-rooms";

const foldKey = (base: string) => `orbit:room-notice-open:${base}`;

function readOpen(base: string): boolean {
  try {
    return localStorage.getItem(foldKey(base)) === "1";
  } catch {
    return false;
  }
}

export function RoomNotice({ base, line, text, onJump }: { base: string; line?: RoomLine; text?: string; onJump: (id: string) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(() => readOpen(base));
  const body = (line?.text ?? text ?? "").trim();
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(foldKey(base), open ? "0" : "1");
    } catch {}
  };
  return (
    <div data-room-notice className="w-full shrink-0 px-5 pt-1">
      <div className="mx-auto mb-2 flex max-w-[48rem] items-start gap-2 rounded-lg border border-accent/25 bg-accent/[0.07] px-3 py-1.5">
        <Megaphone size={14} className="mt-[3px] shrink-0 text-accent" />
        <button
          type="button"
          data-room-notice-jump
          onClick={() => line && onJump(line.id)}
          title={t("teamRoom.noticeJump")}
          className="min-w-0 flex-1 text-left text-[13px] text-ink"
        >
          {body
            ? <span className={cn("block", open ? "max-h-48 overflow-y-auto break-words whitespace-pre-wrap" : "truncate")}>{open ? body : body.split("\n")[0]}</span>
            : <span className="text-ink-secondary">{t("teamRoom.notice")}</span>}
        </button>
        {body.includes("\n") || body.length > 60 ? (
          <button
            type="button"
            data-room-notice-fold
            onClick={toggle}
            aria-expanded={open}
            aria-label={t(open ? "teamRoom.noticeFold" : "teamRoom.noticeExpand")}
            title={t(open ? "teamRoom.noticeFold" : "teamRoom.noticeExpand")}
            className="shrink-0 rounded p-0.5 text-ink-secondary hover:bg-raised hover:text-ink"
          >
            {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        ) : null}
      </div>
    </div>
  );
}
