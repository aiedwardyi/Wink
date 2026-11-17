import { MessagesSquare } from "lucide-react";

import { FORUM_SELECTION, isForumSelection } from "@/lib/board";
import { useI18n } from "@/lib/i18n";
import { useStore } from "@/state/store";

/** The chat the Forum was opened from; the button pressed again goes back to it. */
let openedFrom = "";

/** The Forum's header button; it sits next to Devices and matches it. */
export function BoardButton({ onOpen }: { onOpen?: () => void }) {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  return (
    <button
      type="button"
      data-board-button
      onClick={() => {
        const open = isForumSelection(state.selectedId);
        const id = open ? openedFrom || (state.bots.find((b) => !b.hidden)?.id ?? state.bots[0]?.id ?? "") : FORUM_SELECTION;
        openedFrom = open ? "" : state.selectedId;
        dispatch({ type: "select", id, reveal: true });
        onOpen?.();
      }}
      aria-label={t("chrome.forum")}
      aria-current={isForumSelection(state.selectedId) ? "page" : undefined}
      title={t("chrome.forum")}
      className="flex size-10 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
    >
      <MessagesSquare size={20} />
    </button>
  );
}
