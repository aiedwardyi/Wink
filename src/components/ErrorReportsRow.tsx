import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { api } from "@/state/store";
import { Card } from "./SettingsPrimitives";
import { usageStatsSwitched } from "@/lib/usage-stats";

export function ErrorReportsRow() {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const consent = useRef<{ reports?: boolean; usage?: boolean }>({});
  const read = async () => {
    const [reports, usage] = await Promise.allSettled([window.ogb?.errorReportConsent?.(), api("/api/analytics")]);
    if (reports.status === "fulfilled") consent.current.reports = reports.value === true;
    if (usage.status === "fulfilled") consent.current.usage = usage.value.enabled === true;
    const value = consent.current;
    return value.reports || value.usage ? true : value.reports === false && value.usage === false ? false : undefined;
  };
  useEffect(() => {
    if (ready) return;
    let gone = false;
    let retry: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      const value = await read();
      if (gone) return;
      if (value !== undefined) setEnabled(value);
      setReady(value !== undefined);
      if (value === undefined) retry = setTimeout(() => void refresh(), 2000);
    };
    void refresh();
    return () => { gone = true; clearTimeout(retry); };
  }, [ready]);
  if (!window.ogb?.setErrorReportConsent) return null;
  const toggle = async () => {
    if (saving || !ready) return;
    setSaving(true);
    try {
      const results = await Promise.allSettled([
        window.ogb?.setErrorReportConsent?.(!enabled),
        api("/api/analytics", { method: "PUT", body: JSON.stringify({ enabled: !enabled }) }),
      ]);
      if (results[0].status === "fulfilled") consent.current.reports = !enabled;
      if (results[1].status === "fulfilled") {
        consent.current.usage = !enabled;
        usageStatsSwitched(results[1].value?.capture === true);
      }
      if (results.some((result) => result.status === "rejected")) throw new Error("Consent update failed");
      setEnabled(!enabled);
    } catch {
      const value = await read();
      if (value !== undefined) setEnabled(value);
      setReady(value !== undefined);
    } finally { setSaving(false); }
  };
  return (
    <Card>
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-[14px] font-medium text-ink">{t("settings.errorReports.title")}</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{t("settings.errorReports.help")}</div>
        </div>
        <button type="button" role="switch" aria-label={t("settings.errorReports.title")} aria-checked={enabled}
          disabled={!ready || saving} onClick={() => void toggle()}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${enabled ? "bg-accent" : "bg-control"} disabled:opacity-50`}>
          <span className={`absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white transition-all ${enabled ? "left-[21px]" : "left-[3px]"}`} />
        </button>
      </div>
    </Card>
  );
}
