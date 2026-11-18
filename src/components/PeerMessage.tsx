import { useState } from "react";
import { cn } from "@/lib/cn";
import { localizeServerLine } from "@/lib/activity-runs";
import { useI18n, type Translate } from "@/lib/i18n";
import type { Message } from "@/state/store";
import { FoldClip } from "./FoldClip";

// the fold a long user message gets in ChatView
const FOLD_CHARS = 600;
const FOLD_LINES = 8;

/** A comm chip's label. Chips without a `peer` mark show the server's line. */
export function commLabel(message: Message, t: Translate): string {
  const comm = message.comm;
  if (comm?.peer === "message") return t("chat.messageToBot", { name: comm.withName });
  if (comm?.peer === "reply") return t("chat.replyFromBot", { name: comm.withName });
  if (comm?.peer === "from") return t("chat.messageFromBot", { name: comm.withName });
  return localizeServerLine(message.tool?.name ?? "", t);
}

/** The sent message or reply under its comm chip. `short` clips it at 3 lines. */
export function PeerMessageBody({ text, short = false }: { text: string; short?: boolean }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const long = text.length > FOLD_CHARS || text.split("\n").length > FOLD_LINES;
  return (
    <div data-peer-body className="mt-1.5 ml-3 max-w-[min(42rem,78%)] border-l-2 border-hairline/50 pl-3 text-[14px] leading-relaxed whitespace-pre-wrap break-words text-ink">
      {short ? <FoldClip data-peer-text="">{text}</FoldClip> : <div data-peer-text className={cn(long && !expanded && "max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]")}>
        {text}
      </div>}
      {!short && long && (
        <button type="button" onClick={() => setExpanded(!expanded)} className="mt-1 text-[12.5px] text-ink-secondary hover:text-ink">
          {t(expanded ? "chat.showLess" : "chat.showFullMessage")}
        </button>
      )}
    </div>
  );
}
