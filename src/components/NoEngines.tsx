import { useStore } from "@/state/store";
import { EngineConnect } from "@/components/EngineConnect";
import { OrbitMark } from "@/components/OrbitMark";
import { useI18n } from "@/lib/i18n";
import { isPhone } from "@/lib/phone-swipe";

export function NoEngines() {
  const { t } = useI18n();
  const { state, refreshInstances } = useStore();
  const phone = !window.ogb && isPhone();

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-app">
      <div className="m-auto flex w-full max-w-[480px] flex-col items-center px-6 py-12">
        <OrbitMark size={48} />
        <h1 className="mt-5 text-center text-[22px] font-semibold tracking-[-0.02em] text-ink">{t("noEngines.title")}</h1>
        <p className="mt-1.5 break-keep text-center text-[13.5px] leading-relaxed text-ink-secondary">
          {phone ? t("noEngines.phoneBody") : t("noEngines.body")}
        </p>
        {!phone && <div className="mt-7 w-full max-w-[376px]"><EngineConnect instances={state.instances} onRefresh={() => refreshInstances("passive")} /></div>}
      </div>
    </main>
  );
}
