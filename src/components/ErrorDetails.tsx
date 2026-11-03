import { useI18n } from "@/lib/i18n";

export function ErrorDetails({ raw }: { raw?: string }) {
  const { t } = useI18n();
  if (!raw) return null;
  return (
    <details className="mt-1.5 text-[12px] text-ink-secondary">
      <summary className="w-fit cursor-pointer">{t("errors.details")}</summary>
      <div className="mt-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{raw}</div>
    </details>
  );
}
