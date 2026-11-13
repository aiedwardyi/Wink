import { Check, X } from "lucide-react";
import type { MouseEvent } from "react";

import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";

const BUTTON = "flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-control disabled:opacity-50 [@media(pointer:coarse)]:size-11";
// a caller may save on blur, so a press must not move focus before its click lands
const keepFocus = (event: MouseEvent) => event.preventDefault();

export function RenameActions({ onSave, onCancel, disabled }: { onSave: () => void; onCancel: () => void; disabled?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="flex shrink-0">
      <button type="button" disabled={disabled} onMouseDown={keepFocus} onClick={onSave} aria-label={t("rename.save")} title={t("rename.save")} className={cn(BUTTON, "text-accent-text")}>
        <Check size={16} />
      </button>
      <button type="button" disabled={disabled} onMouseDown={keepFocus} onClick={onCancel} aria-label={t("rename.cancel")} title={t("rename.cancel")} className={cn(BUTTON, "text-ink-secondary hover:text-ink")}>
        <X size={16} />
      </button>
    </div>
  );
}
