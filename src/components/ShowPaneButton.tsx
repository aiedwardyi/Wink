import { PanelRightClose, PanelRightOpen } from "lucide-react";

import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { togglePane, useMapThread, useMediaThread, useShowItem } from "@/lib/show-pane";
import { closePane, useVerifyWatch } from "@/lib/verify-watch";

export function ShowPaneButton({ threadId, className }: { threadId: string; className?: string }) {
  const { t } = useI18n();
  const shown = useShowItem();
  const media = useMediaThread();
  const mapping = useMapThread();
  const watch = useVerifyWatch();
  const checking = watch?.threadId === threadId;
  const open = checking || shown?.threadId === threadId || media === threadId || mapping === threadId;
  return (
    <button
      type="button"
      data-show-pane-button
      aria-pressed={open}
      aria-label={t("show.pane")}
      title={t("show.pane")}
      onClick={() => open ? closePane() : togglePane(threadId)}
      className={cn("shrink-0 rounded-md p-1.5 hover:bg-raised hover:text-ink", open ? "text-accent" : "text-ink-secondary", className)}
    >
      {open ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
    </button>
  );
}
