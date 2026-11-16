import { useEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";

import { useI18n } from "@/lib/i18n";
import { usePresence } from "@/lib/use-presence";
import { useBackLayer } from "@/lib/use-back-layer";

export function LocalComputerAutoWarning({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const presence = usePresence(open);
  useBackLayer(open, onCancel);

  useEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!presence.mounted) return null;

  return (
    <div
      data-closing={presence.closing || undefined}
      inert={presence.closing}
      className="animate-fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6 backdrop-blur-[2px]"
      onMouseDown={(event) => event.target === event.currentTarget && onCancel()}
    >
      <div
        role={presence.closing ? undefined : "dialog"}
        aria-modal={!presence.closing || undefined}
        aria-labelledby="local-auto-warning-title"
        aria-describedby="local-auto-warning-body"
        className="animate-pop-in w-full max-w-[420px] rounded-[24px] border border-hairline/50 bg-panel p-5 shadow-2xl shadow-black/50"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warning" />
          <div>
            <h2 id="local-auto-warning-title" className="text-[15px] font-semibold text-ink">
              {t("bot.autoWarning.title")}
            </h2>
            <p id="local-auto-warning-body" className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">
              {t("bot.autoWarning.body")}
            </p>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl px-4 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
          >
            {t("bot.autoWarning.cancel")}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className="rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-accent-ink hover:brightness-110"
          >
            {t("bot.autoWarning.ok")}
          </button>
        </div>
      </div>
    </div>
  );
}
