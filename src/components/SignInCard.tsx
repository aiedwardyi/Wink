// A calm in-chat sign-in for the bot's engine: before the first message when
// the engine is known signed out, and in place of a failed turn's error box.
import { Check, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import type { InstanceInfo } from "@/state/store";
import { useI18n } from "@/lib/i18n";
import { EngineSignIn } from "./EngineSetup";
import { ProviderMark } from "./ProviderIcons";

const BUTTON = "rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-accent-ink hover:brightness-110";

function Row({ instance, title, help, children }: { instance: InstanceInfo; title: string; help: string; children: ReactNode }) {
  return (
    <div data-sign-in-card="" className="flex w-full items-center gap-3 rounded-xl border border-hairline/30 bg-panel/70 px-3 py-2.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-inset">
        <ProviderMark driverKind={instance.driverKind} size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-ink">{title}</div>
        <p className="mt-0.5 text-[12px] leading-snug text-ink-secondary">{help}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function SignInCard({ instance, help, onRetry }: { instance: InstanceInfo; help: string; onRetry?: () => void }) {
  const { t } = useI18n();
  return (
    <Row instance={instance} title={t("engine.signInTo", { name: instance.displayName })} help={help}>
      <div className="flex flex-col items-end gap-1.5">
        <EngineSignIn instance={instance} buttonClassName={BUTTON} />
        {/* agy never reports signed-in, so this card can't flip to Retry */}
        {onRetry && <button type="button" onClick={onRetry} className="text-[12px] text-ink-secondary underline hover:text-ink">{t("composer.retry")}</button>}
      </div>
    </Row>
  );
}

/** The same row once the engine is ready: the failed turn can go again. */
export function SignedInCard({ instance, onRetry }: { instance: InstanceInfo; onRetry?: () => void }) {
  const { t } = useI18n();
  return (
    <Row instance={instance} title={t("chat.engineReady", { name: instance.displayName })} help={t(onRetry ? "chat.engineReadyRetry" : "chat.engineReadyHelp")}>
      {onRetry ? (
        <button type="button" onClick={onRetry} className={`${BUTTON} flex items-center gap-1.5`}>
          <RefreshCw size={12} /> {t("composer.retry")}
        </button>
      ) : <Check size={16} className="text-success" />}
    </Row>
  );
}
