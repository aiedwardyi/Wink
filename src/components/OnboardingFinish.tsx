import { useState } from "react";
import { Star } from "lucide-react";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { api } from "@/state/store";
import { OrbitMark } from "./OrbitMark";

const REPO = "https://github.com/aiedwardyi/Wink";

export function OnboardingFinish({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const [share, setShare] = useState<boolean | null>(null);
  const pick = (enabled: boolean) => {
    setShare(enabled);
    void api("/api/analytics", { method: "PUT", body: JSON.stringify({ enabled }) }).catch(() => {});
  };
  return (
    <div className="flex flex-col items-center px-8 py-9">
      <OrbitMark size={56} />
      <h1 id="onboarding-title" className="mt-5 text-[20px] font-semibold tracking-[-0.02em] text-ink">{t("onboarding.analyticsTitle")}</h1>
      <p className="mt-1.5 max-w-[420px] break-keep text-center text-[13.5px] leading-relaxed text-ink-secondary">
        {t("onboarding.analyticsBody")}
      </p>
      <div role="radiogroup" aria-labelledby="onboarding-title" className="mt-6 flex w-full gap-1 rounded-lg bg-inset p-0.5">
        {[true, false].map((enabled) => (
          <button
            key={String(enabled)}
            type="button"
            role="radio"
            aria-checked={share === enabled}
            onClick={() => pick(enabled)}
            className={cn(
              "min-w-0 flex-1 rounded-[max(0px,calc(var(--radius-lg)_-_2px))] px-2 py-2 text-center text-[13px] font-medium transition-colors",
              share === enabled ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
            )}
          >
            {enabled ? t("onboarding.analyticsYes") : t("onboarding.analyticsNo")}
          </button>
        ))}
      </div>
      <p className="mt-2 text-[12px] text-ink-secondary">{t("onboarding.analyticsLater")}</p>
      <div className="mt-7 flex w-full gap-2.5">
        <a
          href={REPO}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => {
            if (window.ogb?.openExternal) {
              event.preventDefault();
              void window.ogb.openExternal(REPO).catch(() => {});
            }
          }}
          className="flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-[13px] text-ink-secondary hover:bg-control hover:text-ink"
        >
          <Star size={14} aria-hidden />
          {t("onboarding.starGithub")}
        </a>
        <button type="button" onClick={onDone} className="flex-1 rounded-xl bg-accent py-2.5 text-[14px] font-semibold text-accent-ink transition-[filter,transform] hover:brightness-110 active:scale-[0.99]">{t("onboarding.openOrbit")}</button>
      </div>
    </div>
  );
}
