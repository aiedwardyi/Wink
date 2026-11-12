import { useState } from "react";
import { Star } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { api } from "@/state/store";
import { OrbitMark } from "./OrbitMark";
import { trackFeature, trackOnboard, usageStatsSwitched } from "@/lib/usage-stats";

const REPO = "https://github.com/aiedwardyi/Wink";

export function OnboardingFinish({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const [share, setShare] = useState(true);
  const open = () => {
    trackOnboard("finish");
    void api("/api/analytics", { method: "PUT", body: JSON.stringify({ enabled: share }) }).then((body) => usageStatsSwitched(body.capture === true)).catch(() => {});
    onDone();
  };
  return (
    <div className="flex flex-col">
      <div className="flex flex-col items-center px-8 pt-10 pb-7">
        <div className="relative">
          <div className="absolute inset-2 rounded-full bg-accent/20 blur-2xl" />
          <OrbitMark size={82} />
        </div>
        <h1 id="onboarding-title" className="mt-5 text-[22px] font-semibold tracking-[-0.02em] text-ink">{t("onboarding.doneTitle")}</h1>
        <button type="button" onClick={open} className="mt-7 w-full max-w-60 rounded-xl bg-accent py-2.5 text-[14px] font-semibold text-accent-ink transition-[filter,transform] hover:brightness-110 active:scale-[0.99]">{t("onboarding.openOrbit")}</button>
        <a
          href={REPO}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => {
            trackFeature("star.click");
            if (window.ogb?.openExternal) {
              event.preventDefault();
              void window.ogb.openExternal(REPO).catch(() => {});
            }
          }}
          className="mt-1.5 flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-[13px] text-ink-secondary hover:bg-control hover:text-ink"
        >
          <Star size={14} aria-hidden />
          {t("onboarding.starGithub")}
        </a>
      </div>
      <div className="@container flex justify-center border-t border-hairline/50 px-6 py-1.5">
        <label className="flex cursor-pointer flex-col items-center gap-0.5 rounded-lg p-2 text-[12.5px] text-ink-secondary hover:text-ink has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus @md:flex-row @md:gap-2">
          <span className="flex items-center gap-2">
            <input type="checkbox" checked={share} onChange={() => setShare(!share)} className="size-3.5 shrink-0 accent-accent" />
            {t("onboarding.analyticsLabel")}
          </span>
          <span aria-hidden className="hidden @md:inline">·</span>
          <span>{t("onboarding.analyticsHint")}</span>
        </label>
      </div>
    </div>
  );
}
