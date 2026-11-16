import { MessagesSquare } from "lucide-react";

import { FORUM_SELECTION, isForumSelection } from "@/lib/board";
import { useI18n } from "@/lib/i18n";
import { useStore } from "@/state/store";

/** The Forum's header button; it sits next to Devices and matches it. */
export function BoardButton({ onOpen }: { onOpen?: () => void }) {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  return (
    <button
      type="button"
      data-board-button
      onClick={() => {
        dispatch({ type: "select", id: FORUM_SELECTION, reveal: true });
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
