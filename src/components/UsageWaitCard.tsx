// The quota subview of a chat error row: today's wait states and the engine's own words, cleaned, then a link to Usage.
import { ChevronRight, Gauge, RefreshCw } from "lucide-react";
import type { UsageWaitView } from "../../server/limit-wait-store";
import { api, useOptionalStoreDispatch } from "@/state/store";
import { useI18n } from "@/lib/i18n";
import { safeProviderText } from "@/lib/safe-provider-text";
import { usageLimitReset } from "@/lib/usage";
import { useNow } from "./PlanUsageBar";

export function UsageWaitCard({ message, botId, usageLimit, usageWait, onRetry, retryDisabled, identities = [] }: {
  message: string;
  /** Every known account identity, scrubbed from the engine's words with any email shape. */
  identities?: readonly (string | undefined)[];
  botId: string;
  usageLimit: { resetsAt: number | null };
  usageWait?: UsageWaitView;
  onRetry?: () => void;
  retryDisabled?: boolean;
}) {
  const { t, locale } = useI18n();
  const dispatch = useOptionalStoreDispatch();
  const now = useNow();
  const reset = !usageWait ? usageLimitReset(usageLimit.resetsAt, now) : null;
  const waiting = usageWait?.state === "waiting";
  const time = usageWait?.resumesAt == null ? "" : new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", ...(usageWait.weekly ? { weekday: "short" } : {}) }).format(usageWait.resumesAt);
  const details = safeProviderText(message, identities);
  return (
    <div className="animate-fade-in flex justify-start">
      <div data-usage-wait="" className="w-fit max-w-[min(42rem,78%)] rounded-xl border border-hairline/50 bg-inset px-3.5 py-2.5 text-[13.5px] text-ink">
        <div className="flex items-start gap-2">
          <Gauge size={15} className="mt-0.5 shrink-0 text-warning" />
          <span className="min-w-0 break-words">
            {!usageWait ? <><span className="font-semibold">{t("chat.usageLimit")}</span>{" "}{t("chat.usageLimitBody")}{reset && <> {t(reset.key, reset.vars)}</>}</>
              : waiting ? <span>{t(!time ? "chat.usageWaitUnknown" : usageWait.weekly ? "chat.usageWaitWeekly" : "chat.usageWaitAt", { time })}</span>
                : usageWait.state === "manual" ? <span>{t("chat.usageWaitManual")}</span> : null}
            {waiting && usageWait.cancelable && <> · <button className="underline" onClick={() => void api(`/api/bots/${botId}/usage-wait/${usageWait.id}/cancel`, { method: "POST" }).catch(() => {})}>{t("chat.cancelQueuedAction")}</button></>}
            {details && <span data-engine-details-body="" className="mt-1 block break-words text-[12px] text-ink-secondary">{details}</span>}
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-[23px] text-[12.5px] text-ink-secondary">
          {!usageWait && onRetry && (
            <button onClick={onRetry} disabled={retryDisabled}
              className="flex items-center gap-1.5 rounded-full border border-warning/30 px-2.5 py-1 text-ink hover:bg-warning/15 disabled:pointer-events-none disabled:opacity-50">
              <RefreshCw size={12} /> {t("composer.retry")}
            </button>
          )}
          {dispatch && (
            <button type="button" data-all-usage="" onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "usage" })}
              className="inline-flex items-center gap-0.5 hover:text-ink [@media(pointer:coarse)]:-my-[13px] [@media(pointer:coarse)]:py-[13px]">
              {t("usage.wait.allUsage")}<ChevronRight size={13} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
