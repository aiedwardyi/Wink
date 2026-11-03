import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { api } from "@/state/store";
import { Card } from "./SettingsPrimitives";

export function ErrorReportsRow() {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const read = async () => {
    const [reports, usage] = await Promise.all([window.ogb?.errorReportConsent?.(), api("/api/analytics")]);
    return reports === true || usage.enabled === true;
  };
  useEffect(() => {
    let gone = false;
    void read().then((value) => {
      if (!gone) { setEnabled(value); setReady(true); }
    }).catch(() => {});
    return () => { gone = true; };
  }, []);
  const toggle = async () => {
    if (saving || !ready) return;
    setSaving(true);
    try {
      const results = await Promise.allSettled([
        window.ogb?.setErrorReportConsent?.(!enabled),
        api("/api/analytics", { method: "PUT", body: JSON.stringify({ enabled: !enabled }) }),
      ]);
      if (results.some((result) => result.status === "rejected")) throw new Error("Consent update failed");
      setEnabled(!enabled);
    } catch {
      try { setEnabled(await read()); } catch {}
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
