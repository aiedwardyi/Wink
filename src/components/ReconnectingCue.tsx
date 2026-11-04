import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useStore } from "@/state/store";

// A woken phone or a network blip reconnects well inside this; a PC that went away does not.
const GRACE_MS = 2_000;

export function ReconnectingCue() {
  const { t } = useI18n();
  const { state } = useStore();
  const waiting = !state.connected;
  const [shown, setShown] = useState(false);
  const [stale, setStale] = useState(false);
  useEffect(() => {
    setShown(false);
    setStale(false);
    if (!waiting) return;
    const id = window.setTimeout(() => setShown(true), GRACE_MS);
    const stuck = window.setTimeout(() => setStale(true), 10_000);
    return () => { window.clearTimeout(id); window.clearTimeout(stuck); };
  }, [waiting]);
  if (!shown) return null;
  if (!state.hasConnected && !stale) return <div role="status" className="mb-2 px-5 text-center text-[13px] text-ink-secondary">{t("activity.updating")}</div>;
  return (
    <div className="flex w-full justify-center px-5">
      <div role="status" className="mb-2 flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary">
        <Loader2 size={13} className="animate-spin" />
        {t("activity.reconnecting")}
      </div>
    </div>
  );
}
