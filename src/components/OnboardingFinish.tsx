import { useState } from "react";
import { Star } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { api } from "@/state/store";
import { OrbitMark } from "./OrbitMark";

const REPO = "https://github.com/aiedwardyi/Wink";

export function OnboardingFinish({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const [share, setShare] = useState(true);
  const open = () => {
    void api("/api/analytics", { method: "PUT", body: JSON.stringify({ enabled: share }) }).catch(() => {});
    onDone();
  };
  return (
    <div className="flex flex-col items-center px-8 py-9">
      <OrbitMark size={56} />
      <h1 id="onboarding-title" className="mt-5 text-[20px] font-semibold tracking-[-0.02em] text-ink">{t("onboarding.doneTitle")}</h1>
      <label className="mt-6 flex w-full cursor-pointer items-start gap-3 rounded-xl border border-hairline/30 bg-card p-3.5 text-left">
        <input type="checkbox" checked={share} onChange={() => setShare(!share)} className="mt-0.5 size-4 shrink-0 accent-accent" />
        <span className="min-w-0">
          <span className="block text-[13.5px] font-medium text-ink">{t("onboarding.analyticsLabel")}</span>
          <span className="mt-0.5 block text-[12px] leading-relaxed text-ink-secondary">{t("settings.analytics.help")}</span>
        </span>
      </label>
      <div className="mt-6 flex w-full items-center justify-between gap-2.5">
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
        <button type="button" onClick={open} className="rounded-xl bg-accent px-4 py-2.5 text-[13px] font-semibold text-accent-ink transition-[filter,transform] hover:brightness-110 active:scale-[0.99]">{t("onboarding.openOrbit")}</button>
      </div>
    </div>
  );
}
