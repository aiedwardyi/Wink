import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { InstanceInfo } from "@/state/store";
import { isRetiredEngineKind } from "../../shared/model-selection.ts";
import { engineAuthState, setupEngine } from "@/lib/accounts";
import { baseInstances } from "@/lib/cross-model-picker";
import { OrbitMark } from "./OrbitMark";
import { isEmptyEngineLaunch } from "@/lib/engine-rail";
import { EngineConnect } from "./EngineConnect";
import { OnboardingFinish } from "./OnboardingFinish";
import { useI18n } from "@/lib/i18n";
import { trackOnboard } from "@/lib/usage-stats";

export function Onboarding({ onDone, retryProfile, saving, saveError }: {
  onDone: (enabled?: boolean) => void;
  retryProfile?: () => void;
  saving?: boolean;
  saveError?: boolean;
}) {
  const { t } = useI18n();
  const [step, setStep] = useState(0);
  const [connectSession, setConnectSession] = useState(false);
  const [instances, setInstances] = useState<InstanceInfo[] | null>(null);
  const [instancesError, setInstancesError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const browser = !window.ogb;
  const refreshInstancesRef = useRef<() => Promise<void>>(async () => {});
  const dialogRef = useRef<HTMLDivElement>(null);
  const lastFocused = useRef<HTMLElement>(null);
  const welcomed = useRef(false);
  const hidden = browser && instances === null && !signedOut && !instancesError;
  const welcomeChecking = step === 0 && !instances && !instancesError && !signedOut;

  useEffect(() => {
    if (retryProfile) return;
    let active = true;
    let pending: Promise<void> | undefined;
    let recheck: ReturnType<typeof setTimeout> | undefined;
    const refresh = (probe: boolean) => {
      if (pending) return pending;
      clearTimeout(recheck);
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
          if (!data) return;
          const rows = (data.instances ?? []) as InstanceInfo[];
          setInstances(rows);
          const checkingSignIn = baseInstances(rows).some((row) => row.snapshot.state === "available"
            && !isRetiredEngineKind(row.driverKind) && engineAuthState(setupEngine(row, rows)) === "checking");
          // A cached read won't restart a finished probe with an unknown sign-in answer.
          if (checkingSignIn || rows.some((row) => row.snapshot.state === "checking")) recheck = setTimeout(() => void refresh(checkingSignIn), 500);
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
      clearTimeout(recheck);
      window.removeEventListener("focus", onFocus);
    };
  }, [retryProfile]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const controls = () => [...dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )];
    // The last step takes focus itself, so a held Enter cannot skip it.
    (step === 2 && !signedOut ? dialog : controls()[0] ?? dialog).focus({ preventScroll: true });
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
  }, [step, hidden, welcomeChecking, signedOut]);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const previous = lastFocused.current;
    const active = document.activeElement;
    if (step !== 1 || !dialog || !previous) return;
    if (active && active !== document.body && (active !== previous || !previous.matches(":disabled"))) return;
    (dialog.contains(previous) && !previous.matches(":disabled") ? previous : dialog).focus({ preventScroll: true });
  }, [instances, step]);

  // A browser on a PC that already has bots closes setup before showing it.
  useEffect(() => {
    if (hidden || retryProfile || welcomed.current) return;
    welcomed.current = true;
    trackOnboard("welcome");
  }, [hidden, retryProfile]);

  if (hidden) return null;

  const emptyConnect = step === 0 ? instances !== null && isEmptyEngineLaunch(instances) : connectSession;
  const retryInstances = () => refreshInstancesRef.current();

  const finish = () => {
    if (!hasReadyEngine) return onDone();
    trackOnboard("ready");
    setStep(2);
  };

  const hasReadyEngine = instances !== null && baseInstances(instances).some((instance) => {
    if (isRetiredEngineKind(instance.driverKind)) return false;
    const state = engineAuthState(setupEngine(instance, instances));
    return state === "ready" || state === "unverified";
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-app/95 p-6 backdrop-blur-xl">
      <div
        ref={dialogRef}
        onFocusCapture={(event) => { lastFocused.current = event.target; }}
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="onboarding-title"
        className={`flex max-h-full w-full flex-col overflow-hidden rounded-[24px] border border-hairline/50 bg-panel shadow-2xl shadow-black/60 ${
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
              className="mt-6 w-full rounded-xl bg-accent py-2.5 text-[14px] font-semibold text-accent-ink hover:brightness-110"
            >
              {t("onboarding.phoneTryAgain")}
            </button>
          </div>
        ) : step === 2 ? (
          <OnboardingFinish onDone={onDone} saving={saving} saveError={saveError} />
        ) : step === 0 ? (
          <div className="flex flex-col items-center px-8 py-9">
            <div className="relative">
              <div className="absolute inset-2 rounded-full bg-accent/20 blur-2xl" />
              <OrbitMark size={82} />
            </div>
            <h1 id="onboarding-title" className="mt-5 text-[22px] font-semibold tracking-[-0.02em] text-ink">{t(retryProfile ? "onboarding.enginesError" : "onboarding.welcomeTitle")}</h1>
            <p className="mt-1.5 max-w-[420px] text-center text-[13.5px] leading-relaxed text-ink-secondary">
              {t(retryProfile ? "onboarding.enginesErrorHint" : "onboarding.welcomeBody")}
            </p>

            {instancesError && (
              <div role="alert" className="mt-4 w-full rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-3 text-[12.5px] text-danger">
                {instancesError} {t("onboarding.enginesErrorHint")}
              </div>
            )}
            <button
              type="button"
              disabled={!instances && !instancesError && !retryProfile}
              onClick={() => {
                if (retryProfile) return retryProfile();
                if (instancesError) return retryInstances();
                if (hasReadyEngine) return finish();
                setConnectSession(emptyConnect);
                trackOnboard("engine");
                setStep(1);
              }}
              className={`${instancesError ? "mt-3" : "mt-6"} w-full rounded-xl bg-accent py-2.5 text-[14px] font-semibold text-accent-ink hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40`}
            >
              {instancesError || retryProfile ? t("onboarding.tryAgain") : !instances ? t("onboarding.checking") : emptyConnect ? t("noEngines.title") : t("onboarding.continue")}
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
            <div className={`mt-5 flex min-h-0 flex-col ${emptyConnect ? "" : "gap-2.5 overflow-y-auto pr-1 [scrollbar-width:thin]"}`}>
              {(instancesError || saveError) && (
                <div role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-3 text-[12.5px] text-danger">
                  {instancesError ? <>{instancesError} {t("onboarding.enginesErrorHint")}</> : t("errors.request")}
                </div>
              )}
              {instances && <EngineConnect instances={instances} onRefresh={retryInstances} recheckOnFocus={false}
                footer={emptyConnect && !instancesError && !saveError ? { back: () => setStep(0), open: finish, disabled: saving } : {
                  back: () => setStep(0), open: instancesError ? retryInstances : finish,
                  label: instancesError || (emptyConnect && saveError) ? "onboarding.tryAgain" : "onboarding.continue",
                  disabled: saving || (!instancesError && !emptyConnect && !hasReadyEngine),
                  skip: saving || hasReadyEngine ? undefined : emptyConnect ? (instancesError ? finish : undefined) : () => onDone(),
                }} />}
              {!emptyConnect && <p className="px-1 pt-1 text-[11px] text-ink-secondary/70">{t("onboarding.moreInSettings")}</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
