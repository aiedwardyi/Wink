import type { MouseEvent } from "react";
import { FileText, Globe, PanelRight } from "lucide-react";

import { useI18n } from "@/lib/i18n";
import { linkedFileSrc, showItem, showKind, showName, useShowItem } from "@/lib/show-pane";

/** A bot's showable file in chat; lit while the pane shows it, a tap shows it again. */
export function ShowCard({ threadId, path, onOpen }: { threadId: string; path: string; onOpen?: () => void }) {
  const { t } = useI18n();
  const shown = useShowItem();
  const kind = showKind(path)!;
  const name = showName(path);
  const lit = shown?.threadId === threadId && shown.path === path;
  const menu = (event: MouseEvent) => {
    const fileMenu = window.ogb?.fileMenu;
    if (!fileMenu) return;
    event.preventDefault();
    void fileMenu(path).catch(() => {});
  };
  return (
    <button
      type="button"
      data-show-card
      data-showing={lit || undefined}
      aria-pressed={lit}
      aria-label={t("show.card", { name })}
      title={path}
      onClick={onOpen ?? (() => showItem({ threadId, path, kind }))}
      onContextMenu={menu}
      className="my-0.5 flex w-full max-w-[320px] min-w-0 items-center gap-2.5 rounded-xl border border-hairline/40 bg-raised/50 p-1.5 pr-2.5 text-left align-middle transition-colors hover:bg-raised data-showing:border-accent/70 data-showing:bg-raised data-showing:ring-1 data-showing:ring-accent/40"
    >
      <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-inset text-ink-secondary">
        {kind === "image" ? <img src={linkedFileSrc(threadId, path)} alt="" loading="lazy" className="size-full object-cover" /> : kind === "pdf" ? <FileText size={18} /> : <Globe size={18} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-ink">{name}</span>
        <span className="block text-[11.5px] text-ink-secondary">{t(`show.kind.${kind}`)}</span>
      </span>
      <PanelRight data-show-icon size={15} aria-hidden="true" className="shrink-0 text-ink-secondary" />
    </button>
  );
}
