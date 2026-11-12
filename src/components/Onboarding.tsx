import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { InstanceInfo } from "@/state/store";
import { isRetiredEngineKind } from "../../shared/model-selection.ts";
import { OrbitMark } from "./OrbitMark";
import { isEmptyEngineLaunch } from "@/lib/engine-rail";
import { EngineConnect } from "./EngineConnect";
import { OnboardingFinish } from "./OnboardingFinish";
import { useI18n } from "@/lib/i18n";
import { trackOnboard } from "@/lib/usage-stats";

function engineReady(instance: InstanceInfo): boolean {
  return (
    instance.snapshot.state === "available" &&
    (instance.access === "custom" || instance.snapshot.authenticated !== false)
  );
}

export function Onboarding({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const [step, setStep] = useState(0);
  const [connectSession, setConnectSession] = useState(false);
  const [instances, setInstances] = useState<InstanceInfo[] | null>(null);
  const [instancesError, setInstancesError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const browser = !window.ogb;
  const refreshInstancesRef = useRef<() => Promise<void>>(async () => {});
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => trackOnboard("welcome"), []);

  useEffect(() => {
    let active = true;
    let pending: Promise<void> | undefined;
    const refresh = (probe: boolean) => {
      if (pending) return pending;
      setInstancesError(null);
      pending = fetch(probe ? "/api/instances?refresh=1" : "/api/instances")
        .then((response) => {
          // A browser without this PC's cookie, not a broken engine check.
          if (response.status === 401) return null;
          if (!response.ok) throw new Error(`engine check failed with ${response.status}`);
          return response.json();
        })
        .then(async (data) => {
          if (!active) return;
          if (data && browser) {
            const response = await fetch("/api/bots?messages=0");
            if (response.status === 401) data = null;
            else {
              if (!response.ok) throw new Error(`setup check failed with ${response.status}`);
              const { bots } = await response.json();
              if (!active) return;
              if (bots?.length) return onDone();
            }
          }
          if (!active) return;
          setSignedOut(!data);
          if (data) setInstances(data.instances ?? []);
        })
        .catch(() => {
          if (active) {
            setSignedOut(false);
            setInstancesError(t("onboarding.enginesError"));
          }
        }).finally(() => { pending = undefined; });
      return pending;
    };
    refreshInstancesRef.current = () => refresh(true);
    void refresh(false);
    const onFocus = () => { void refresh(true); };
    window.addEventListener("focus", onFocus);
    return () => {
      active = false;
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const controls = () => [...dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )];
    const primary = step === 1 && instances?.some(engineReady)
      ? dialog.querySelector<HTMLElement>("[data-engine-connect-primary]:not([disabled])") : null;
    // The last step takes focus itself, so a held Enter cannot skip it.
    (step === 2 ? dialog : primary ?? controls()[0])?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = controls();
      if (!focusable.length) return event.preventDefault();
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", onKey);
    return () => dialog.removeEventListener("keydown", onKey);
  }, [step, instances, instancesError, signedOut]);

  if (browser && instances === null && !signedOut && !instancesError) return null;

  const emptyConnect = connectSession || instances !== null && isEmptyEngineLaunch(instances);

  const retryInstances = () => {
    // Keep setup visible while an install probe runs.
    if (!emptyConnect) setInstances(null);
    setInstancesError(null);
    return refreshInstancesRef.current();
  };

  const finish = () => {
    if (!hasReadyEngine) return onDone();
    trackOnboard("ready");
    setStep(2);
  };

  const live = (instances ?? []).filter((instance) => !isRetiredEngineKind(instance.driverKind));
  const hasReadyEngine = live.some(engineReady);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-app/95 p-6 backdrop-blur-xl">
      <div
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="onboarding-title"
        className={`flex max-h-full w-full flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-panel shadow-2xl shadow-black/60 ${
          step === 1 ? "max-w-[680px]" : "max-w-[560px]"
        }`}
      >
        {signedOut ? (
          <div className="flex flex-col items-center px-8 py-9">
            <OrbitMark size={56} />
            <h1 id="onboarding-title" className="mt-5 text-[20px] font-semibold tracking-[-0.02em] text-ink">{t("onboarding.signInTitle")}</h1>
            <p className="mt-1.5 max-w-[420px] break-keep text-center text-[13.5px] leading-relaxed text-ink-secondary">
              {t("onboarding.signInBody")}
            </p>
            <button
              type="button"
              onClick={retryInstances}
              className="mt-6 w-full rounded-xl bg-accent py-2.5 text-[14px] font-semibold text-accent-ink transition-[filter,transform] hover:brightness-110 active:scale-[0.99]"
            >
              {t("onboarding.phoneTryAgain")}
            </button>
          </div>
        ) : step === 2 ? (
          <OnboardingFinish onDone={onDone} />
        ) : step === 0 ? (
          <div className="flex flex-col items-center px-8 py-9">
            <div className="relative">
              <div className="absolute inset-2 rounded-full bg-accent/20 blur-2xl" />
              <OrbitMark size={82} />
            </div>
            <h1 id="onboarding-title" className="mt-5 text-[22px] font-semibold tracking-[-0.02em] text-ink">{t("onboarding.welcomeTitle")}</h1>
            <p className="mt-1.5 max-w-[420px] text-center text-[13.5px] leading-relaxed text-ink-secondary">
              {t("onboarding.welcomeBody")}
            </p>

            {instancesError && (
              <div role="alert" className="mt-4 w-full rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-3 text-[12.5px] text-danger">
                {instancesError} {t("onboarding.enginesErrorHint")}
              </div>
            )}
            <button
              type="button"
              disabled={!instances && !instancesError}
              onClick={() => {
                if (instancesError) return retryInstances();
                if (hasReadyEngine) return finish();
                setConnectSession(emptyConnect);
                trackOnboard("engine");
                setStep(1);
              }}
              className={`${instancesError ? "mt-3" : "mt-6"} w-full rounded-xl bg-accent py-2.5 text-[14px] font-semibold text-accent-ink transition-[filter,transform] hover:brightness-110 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40`}
            >
              {instancesError ? t("onboarding.tryAgain") : !instances ? t("onboarding.checking") : emptyConnect ? t("noEngines.title") : t("onboarding.continue")}
            </button>
          </div>
        ) : (
          <div className="flex min-h-0 flex-col p-7">
            <div className="flex items-center gap-3">
              <OrbitMark size={38} />
              <div>
                <h1 id="onboarding-title" className="text-[18px] font-semibold text-ink">{emptyConnect ? t("noEngines.title") : t("onboarding.enginesTitle")}</h1>
                <p className="mt-0.5 text-[12.5px] text-ink-secondary">{emptyConnect ? t("noEngines.body") : t("onboarding.enginesFound")}</p>
              </div>
            </div>
            {emptyConnect && instances ? <div className="mt-5 flex min-h-0 flex-col">
              <EngineConnect instances={instances} onRefresh={retryInstances} recheckOnFocus={false} footer={{ back: () => { setConnectSession(false); setStep(0); }, open: finish }} />
            </div> : <>
            <div className="mt-5 flex min-h-0 flex-col gap-2.5 overflow-y-auto pr-1 [scrollbar-width:thin]">
              {instancesError ? (
                <div role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-3 text-[12.5px] text-danger">
                  {instancesError} {t("onboarding.enginesErrorHint")}
                </div>
              ) : !instances ? (
                <div className="flex items-center justify-center gap-2 py-12 text-[13px] text-ink-secondary">
                  <Loader2 size={15} className="animate-spin" /> {t("onboarding.checking")}
                </div>
              ) : (
                <>
                  <EngineConnect instances={instances} onRefresh={retryInstances} recheckOnFocus={false}
                    footer={{ back: () => setStep(0), open: finish, label: "onboarding.continue", disabled: !hasReadyEngine }} />
                  <p className="px-1 pt-1 text-[11px] text-ink-secondary/70">{t("onboarding.moreInSettings")}</p>
                </>
              )}
            </div>
            {(instancesError || !instances) && <div className="mt-5 flex shrink-0 items-center gap-2.5">
              <button type="button" onClick={() => setStep(0)} className="rounded-xl px-4 py-2.5 text-[13px] text-ink-secondary hover:bg-control hover:text-ink">{t("onboarding.back")}</button>
              <button type="button" onClick={instancesError ? retryInstances : finish} disabled={!instancesError && !hasReadyEngine} className="rounded-xl bg-accent px-4 py-2.5 text-[14px] font-semibold text-accent-ink hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40">{instancesError ? t("onboarding.tryAgain") : t("onboarding.continue")}</button>
            </div>}
            </>}
          </div>
        )}
      </div>
    </div>
  );
}
