import { useId, useState, type ReactNode } from "react";
import { Check, Download } from "lucide-react";
import type { InstanceInfo } from "@/state/store";
import { firstLaunchConnectInstances } from "@/lib/engine-rail";
import { baseInstances } from "@/lib/cross-model-picker";
import { usageAccount } from "@/lib/accounts";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { PRIMARY_BUTTON } from "@/lib/button-style";
import { useEngineInstall } from "@/lib/use-engine-install";
import { EngineSetup, EngineSignIn, engineChecking, installCommandFor, needsSignIn, openEngineInstallOrCopy } from "./EngineSetup";
import { ProviderBrandMark } from "./ProviderIcons";
import { Fold } from "./Fold";
import { trackOnboard } from "@/lib/usage-stats";

const ORDER = ["claudeAgent", "codex", "antigravityAgent", "grokAgent", "museAgent"];
const ACCOUNTS = { codex: "engineConnect.chatgpt", antigravityAgent: "engineConnect.google", grokAgent: "engineConnect.grok", museAgent: "engineConnect.meta" } as const;

export function EngineConnect({ instances, onRefresh, recheckOnFocus = true, footer }: {
  instances: InstanceInfo[];
  onRefresh: () => void | Promise<void>;
  recheckOnFocus?: boolean;
  footer?: { back: () => void; open: () => void; label?: MessageKey; disabled?: boolean; skip?: () => void };
}) {
  const { t } = useI18n();
  const canInstall = Boolean(window.ogb?.openEngineInstall);
  const commandsId = useId();
  const [commands, setCommands] = useState(!canInstall);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const { attempts, begin, fail } = useEngineInstall(instances, onRefresh, recheckOnFocus);
  const engines = firstLaunchConnectInstances(baseInstances(instances)).map((instance) => instance.pickerSnapshot
    ? { ...instance, snapshot: { ...instance.snapshot, authenticated: instance.pickerSnapshot.state === "available" && instance.pickerSnapshot.authenticated !== false } }
    : instance).sort((a, b) => ORDER.indexOf(a.driverKind) - ORDER.indexOf(b.driverKind));
  const hasInstalled = engines.some((instance) => instance.snapshot.state === "available");
  const primary = engines.filter((instance) => hasInstalled ? instance.snapshot.state === "available" : instance.driverKind === "claudeAgent");
  const others = engines.filter((instance) => !primary.includes(instance));
  // Account copies are hidden here, so a base row signs in its Main account.
  const signInAs = (instance: InstanceInfo) => {
    const main = needsSignIn(instance) ? usageAccount(instances, instance.instanceId) : undefined;
    return main && main.instanceId !== instance.instanceId
      ? { ...instance, instanceId: main.instanceId, loginState: main.loginState, loginCapture: main.loginCapture } : instance;
  };

  const install = async (instance: InstanceInfo) => {
    const id = instance.instanceId;
    if (busy[id]) return;
    const command = installCommandFor(instance.install);
    if (!canInstall || !command) { trackOnboard("commands"); setCommands(true); return; }
    trackOnboard("installing", instance.driverKind);
    begin(id);
    setOpened((current) => ({ ...current, [id]: false }));
    setBusy((current) => ({ ...current, [id]: true }));
    try {
      const result = await openEngineInstallOrCopy(id, command);
      if (result === "copied") fail(id);
      if (result === "opened") {
        setOpened((current) => ({ ...current, [id]: true }));
        setCommands(true);
      }
    } catch { fail(id); }
    finally { setBusy((current) => ({ ...current, [id]: false })); }
  };

  const row = (instance: InstanceInfo, recommended = false) => {
    const installed = instance.snapshot.state === "available";
    const ready = installed && instance.snapshot.authenticated !== false;
    const checking = engineChecking(instance);
    const featured = recommended && !ready && !checking;
    const attempt = attempts[instance.instanceId];
    const working = !installed && attempt && !attempt.failed;
    const failed = !installed && attempt?.failed;
    const paste = working && opened[instance.instanceId];
    const label = checking ? t("engines.checking") : ready ? t("engineConnect.ready", { name: instance.displayName })
      : installed ? t("engineConnect.signIn", { name: instance.displayName })
        : working ? t("engineConnect.openAgain")
          : failed ? t("engineConnect.tryAgain")
            : t("engineConnect.install", { name: instance.displayName });
    const accountKey = ACCOUNTS[instance.driverKind as keyof typeof ACCOUNTS];
    const buttonClassName = `flex w-full items-center gap-2.5 rounded-lg disabled:cursor-default ${featured ? `justify-center px-4 py-2.5 text-[14px] font-semibold ${PRIMARY_BUTTON}` : "border border-hairline/60 px-3.5 py-2.5 text-[13px] font-medium text-ink hover:bg-control"}`;
    const content = featured ? <>{!installed && !working && <Download size={15} />}{label}</> : <>
      <ProviderBrandMark driverKind={instance.driverKind} size={16} />{label}
      <span className="ml-auto flex items-center gap-1.5 text-[11.5px] font-normal text-ink-secondary">{accountKey && t(accountKey)}{ready && <Check size={14} />}</span>
    </>;
    // The button gives way while signing in; the name stays so waiting rows are told apart.
    const named = (status: ReactNode) => <div className="flex w-full items-start gap-2.5 rounded-lg border border-hairline/60 px-3.5 py-2.5">
      <span className="flex items-center gap-2.5 text-[13px] font-medium text-ink"><ProviderBrandMark driverKind={instance.driverKind} size={16} />{instance.displayName}</span>
      <div className="ml-auto flex min-w-0 flex-col items-end gap-1.5">{status}</div>
    </div>;
    const button = installed && !ready ? <EngineSignIn instance={signInAs(instance)} buttonLabel={content} buttonClassName={buttonClassName} named={named}
      onUpdated={(next) => { if (next.snapshot.authenticated === true) void onRefresh(); }} />
      // Launchers report spawn, not the window's end, so an open window never locks the button.
      : <button type="button" disabled={Boolean(ready || checking || busy[instance.instanceId])}
      onClick={() => void install(instance)} className={buttonClassName}>{content}</button>;
    return <div key={instance.instanceId} data-engine-connect={instance.instanceId} data-onboarding-ready={ready ? "" : undefined}>
      {button}
      {featured && <p className="mt-2.5 break-keep text-center text-[12px] leading-relaxed text-ink-secondary">{t(installed ? "chat.signInHelp" : "engineConnect.note", { name: instance.displayName })}</p>}
      {working && <p role="status" className="mt-1.5 text-center text-[12px] text-ink-secondary">{t(paste ? "engine.pasteAndEnter" : "engineConnect.finish")}</p>}
      {failed && <p role="status" className="mt-1.5 text-center text-[12px] text-ink-secondary">{t("engineConnect.didntFinish")}</p>}
    </div>;
  };

  return <div data-engine-connect-panel className="flex min-h-0 flex-col">
    <div className="-mx-1 flex min-h-0 flex-col overflow-y-auto px-1 [scrollbar-width:thin]">
      <div className="flex flex-col gap-2">{primary.map((instance) => row(instance, instance.driverKind === "claudeAgent"))}</div>
      <h2 className="my-5 flex items-center gap-3 text-[12px] text-ink-secondary before:h-px before:flex-1 before:bg-hairline/50 after:h-px after:flex-1 after:bg-hairline/50">{t("engineConnect.others")}</h2>
      <div className="flex flex-col gap-2">{others.map((instance) => row(instance))}</div>
      <Fold open={commands}>
        <div id={commandsId} data-engine-connect-commands className="mt-4 flex flex-col gap-2.5">
          {engines.filter((instance) => !engineChecking(instance)).map((instance) => <EngineSetup key={instance.instanceId} instance={signInAs(instance)} intent="cloud" />)}
        </div>
      </Fold>
    </div>
    <div className={`mt-4 flex shrink-0 flex-wrap items-center gap-1 ${footer ? "justify-between" : "justify-center"}`}>
      {footer && <button type="button" onClick={footer.back} className="rounded-xl px-3 py-2.5 text-[13px] text-ink-secondary hover:bg-control hover:text-ink">{t("onboarding.back")}</button>}
      <button type="button" aria-expanded={commands} aria-controls={commandsId} onClick={() => setCommands((current) => !current)}
        className="px-2 py-1 text-[12px] text-ink-secondary underline-offset-2 hover:text-ink hover:underline">{t("engineConnect.commands")}</button>
      {footer && <div className="flex items-center gap-1">
        {footer.skip && <button type="button" onClick={footer.skip} className="rounded-xl px-3 py-2.5 text-[13px] text-ink-secondary hover:bg-control hover:text-ink">{t("onboarding.openOrbit")}</button>}
        <button type="button" data-engine-connect-primary onClick={footer.open} disabled={footer.disabled} className="rounded-xl bg-accent px-4 py-2.5 text-[13px] font-semibold text-accent-ink hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40">{t(footer.label ?? "onboarding.openOrbit")}</button>
      </div>}
    </div>
  </div>;
}
