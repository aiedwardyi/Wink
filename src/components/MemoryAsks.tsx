import { useState } from "react";
import { ChevronRight, ListChecks } from "lucide-react";
import type { Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { askCounts, botAsks, isClosed, type Ask, type AskStatus } from "@/lib/asks";
import { Fold } from "./Fold";

const TAGS = {
  open: "bot.askOpen",
  building: "bot.askBuilding",
  "waiting-for-user": "bot.askWaiting",
  done: "bot.askDone",
  declined: "bot.askDeclined",
} satisfies Record<AskStatus, MessageKey>;

function AskRows({ asks, className }: { asks: Ask[]; className: string }) {
  const { t } = useI18n();
  return (
    <ul className={cn("mm-asks-list", className)}>
      {asks.map((ask) => (
        <li key={`${ask.at}:${ask.text}`} data-status={ask.status}>
          <span className="mm-asks-text" title={ask.text}>{ask.text}</span>
          <span className="mm-asks-tag">{t(TAGS[ask.status])}</span>
        </li>
      ))}
    </ul>
  );
}

export function MemoryAsks({ bot }: { bot: Bot }) {
  const { t } = useI18n();
  const [showDone, setShowDone] = useState(false);
  const asks = botAsks(bot);
  const counts = askCounts(asks);
  const open = asks.filter((ask) => !isClosed(ask));
  return (
    <div className="mm-asks">
      <div className="mm-sec-head">
        <ListChecks size={16} aria-hidden="true" />
        <span className="mm-sec-name">{counts.open ? t("bot.memoryAsksOpen", { count: counts.open }) : t("bot.memoryAsks")}</span>
        <span className="mm-sec-hint">{t("bot.memoryAsksHint")}</span>
      </div>
      {asks.length ? (
        <div className="mm-task mm-asks-box">
          {open.length ? <AskRows asks={open} className="mm-asks-open" /> : <div className="mm-empty">{t("bot.memoryAsksAllDone")}</div>}
          {counts.closed > 0 && (
            <>
              <button type="button" className="mm-asks-done-toggle" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
                {t("bot.memoryAsksDone", { count: counts.closed })}
                <ChevronRight size={14} aria-hidden="true" />
              </button>
              <Fold open={showDone}>
                <AskRows asks={asks.filter(isClosed)} className="mm-asks-closed" />
              </Fold>
            </>
          )}
        </div>
      ) : <div className="mm-empty">{t("bot.memoryAsksNone")}</div>}
    </div>
  );
}
