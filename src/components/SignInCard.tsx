// A calm in-chat sign-in for the bot's engine: before the first message when
// the engine is known signed out, and in place of a failed turn's error box.
import { Check, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import type { InstanceInfo } from "@/state/store";
import { accountReady } from "@/lib/accounts";
import { useI18n } from "@/lib/i18n";
import { EngineSignIn } from "./EngineSetup";
import { ProviderMark } from "./ProviderIcons";

const BUTTON = "rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-accent-ink hover:brightness-110";

function Row({ instance, title, help, children }: { instance: InstanceInfo; title: string; help: string; children: ReactNode }) {
  return (
    <div data-sign-in-card="" className="group/card flex w-full items-center gap-3 has-[[data-computer-only],[data-sign-in-open]]:flex-wrap rounded-xl border border-hairline/30 bg-panel/70 px-3 py-2.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-inset">
        <ProviderMark driverKind={instance.driverKind} size={16} />
      </span>
      <div className="min-w-0 flex-1 group-has-[[data-sign-in-open]]/card:basis-52">
        <div className="text-[13px] font-semibold text-ink">{title}</div>
        <p className="mt-0.5 text-[12px] leading-snug text-ink-secondary">{help}</p>
      </div>
      <div className="shrink-0 has-[[data-computer-only]]:basis-full has-[[data-sign-in-open]]:ml-auto has-[[data-sign-in-open]]:max-w-full">{children}</div>
    </div>
  );
}

export function SignInCard({ instance, help, onRetry, title, buttonLabel }: { instance: InstanceInfo; help: string; onRetry?: () => void; title?: string; buttonLabel?: string }) {
  const { t } = useI18n();
  return (
    <Row instance={instance} title={title ?? t("engine.signInTo", { name: instance.displayName })} help={help}>
      <div className="flex flex-col items-end gap-1.5">
        <EngineSignIn instance={instance} buttonClassName={BUTTON} buttonLabel={buttonLabel} forceSignIn />
        {/* agy never reports signed-in, so this card can't flip to Retry */}
        {onRetry && <button type="button" onClick={onRetry} className="text-[12px] text-ink-secondary underline hover:text-ink">{t("composer.retry")}</button>}
      </div>
    </Row>
  );
}

/** A turn that failed because its account signed out: Sign In Again until that account is ready, then Retry. */
export function AccountSignInCard({ instance, onRetry }: { instance: InstanceInfo; onRetry?: () => void }) {
  const { t } = useI18n();
  if (accountReady(instance)) return <SignedInCard instance={instance} onRetry={onRetry} />;
  return <SignInCard instance={instance} title={t("chat.accountSignedOut", { name: instance.displayName })} help={t("chat.signInRetryHelp")} buttonLabel={t("engines.signInAgain")} />;
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
