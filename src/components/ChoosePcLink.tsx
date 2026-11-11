import { Monitor } from "lucide-react";

import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";

export function ChoosePcLink({ iconOnly = false }: { iconOnly?: boolean }) {
  const { t } = useI18n();
  const host = location.hostname;
  const pc = /^[a-z2-7]{16}\.(.+)$/.exec(host);
  if (window.ogb || host.endsWith(".ts.net") || !pc) return null;
  const label = t("chrome.choosePc");
  return (
    <a
      href={`https://${pc[1]}/?pick=1`}
      aria-label={label}
      title={iconOnly ? label : undefined}
      data-pc-picker
      className={cn(
        "flex min-h-10 items-center gap-2 rounded-md px-3 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink",
        iconOnly && "mx-auto size-10 justify-center px-0",
      )}
    >
      <Monitor size={18} strokeWidth={1.8} className="shrink-0" />
      {!iconOnly && <span>{label}</span>}
    </a>
  );
}
