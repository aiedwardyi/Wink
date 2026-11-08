import { useId, useState } from "react";
import { Check, Download, Loader2 } from "lucide-react";
import type { InstanceInfo } from "@/state/store";
import { firstLaunchConnectInstances } from "@/lib/engine-rail";
import { baseInstances } from "@/lib/cross-model-picker";
import { usageAccount } from "@/lib/accounts";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { useEngineInstall } from "@/lib/use-engine-install";
import { EngineSetup, EngineSignIn, installCommandFor, needsSignIn, openEngineInstallOrCopy } from "./EngineSetup";
import { ProviderMark } from "./ProviderIcons";
import { Fold } from "./Fold";

const ORDER = ["claudeAgent", "codex", "antigravityAgent", "grokAgent", "museAgent"];
const ACCOUNTS = { codex: "engineConnect.chatgpt", antigravityAgent: "engineConnect.google", grokAgent: "engineConnect.grok", museAgent: "engineConnect.meta" } as const;

export function EngineConnect({ instances, onRefresh, recheckOnFocus = true, footer }: {
  instances: InstanceInfo[];
  onRefresh: () => void | Promise<void>;
  recheckOnFocus?: boolean;
  footer?: { back: () => void; open: () => void; label?: MessageKey; disabled?: boolean };
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
    if (!canInstall || !command) { setCommands(true); return; }
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
    const featured = recommended && !ready;
    const attempt = attempts[instance.instanceId];
    const working = !installed && attempt && !attempt.failed;
    const failed = !installed && attempt?.failed;
    const paste = working && opened[instance.instanceId];
    const label = ready ? t("engineConnect.ready", { name: instance.displayName })
      : installed ? t("engineConnect.signIn", { name: instance.displayName })
        : paste ? t("engine.terminalOpened")
          : working ? t("engineConnect.installing", { name: instance.displayName })
            : failed ? t("engineConnect.tryAgain")
              : recommended ? t("engineConnect.install", { name: instance.displayName }) : t("engines.install");
    const accountKey = ACCOUNTS[instance.driverKind as keyof typeof ACCOUNTS];
    const buttonClassName = `flex shrink-0 items-center justify-center gap-2 rounded-lg px-3 py-2 text-[12.5px] font-semibold disabled:cursor-default ${featured ? "w-full bg-accent text-accent-ink hover:brightness-110" : "bg-control text-ink hover:bg-raised-hover"}`;
    const button = installed && !ready ? <EngineSignIn instance={signInAs(instance)} buttonLabel={label} buttonClassName={buttonClassName}
      onUpdated={(next) => { if (next.snapshot.authenticated === true) void onRefresh(); }} />
      : <button type="button" disabled={Boolean(ready || working || busy[instance.instanceId])}
      onClick={() => void install(instance)} className={buttonClassName}>
      {ready || paste ? <Check size={14} /> : working ? <Loader2 size={14} className="animate-spin" /> : recommended ? <Download size={14} /> : null}
      {label}
    </button>;
    return <div key={instance.instanceId} data-engine-connect={instance.instanceId} data-onboarding-ready={ready ? "" : undefined}
      className={featured ? "rounded-xl border border-hairline/50 bg-card p-4" : "border-b border-hairline/30 py-3 last:border-0"}>
      {featured ? <>
        <div className="mb-3 flex items-center gap-2 text-[15px] font-semibold text-ink"><ProviderMark driverKind={instance.driverKind} size={20} />{instance.displayName}</div>
        {button}
        <p className="mt-2.5 break-keep text-[12px] leading-relaxed text-ink-secondary">{t(installed ? "chat.signInHelp" : "engineConnect.note", { name: instance.displayName })}</p>
      </> : <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5"><ProviderMark driverKind={instance.driverKind} size={16} />
          <div><div className="text-[13px] font-medium text-ink">{instance.displayName}</div>
            {accountKey && <div className="mt-0.5 text-[11.5px] text-ink-secondary">{t(accountKey)}</div>}
          </div>
        </div>{button}
      </div>}
      {working && <p role="status" className="mt-2 text-[12px] text-ink-secondary">{t(paste ? "engine.pasteAndEnter" : "engineConnect.finish")}</p>}
      {failed && <p role="status" className="mt-2 text-[12px] text-ink-secondary">{t("engineConnect.didntFinish")}</p>}
    </div>;
  };

  return <div data-engine-connect-panel className="flex min-h-0 flex-col">
    <div className="-mx-1 flex min-h-0 flex-col overflow-y-auto px-1 [scrollbar-width:thin]">
      {primary.map((instance) => row(instance, instance.driverKind === "claudeAgent"))}
      <h2 className="mt-5 text-[12px] font-semibold text-ink-secondary">{t("engineConnect.others")}</h2>
      <div>{others.map((instance) => row(instance))}</div>
      <Fold open={commands}>
        <div id={commandsId} data-engine-connect-commands className="mt-4 flex flex-col gap-2.5">
          {engines.map((instance) => <EngineSetup key={instance.instanceId} instance={signInAs(instance)} intent="cloud" />)}
        </div>
      </Fold>
    </div>
    <div className="mt-4 flex shrink-0 items-center justify-between gap-1">
      {footer && <button type="button" onClick={footer.back} className="rounded-xl px-3 py-2.5 text-[13px] text-ink-secondary hover:bg-control hover:text-ink">{t("onboarding.back")}</button>}
      <button type="button" aria-expanded={commands} aria-controls={commandsId} onClick={() => setCommands((current) => !current)}
        className="rounded-xl px-3 py-2.5 text-[12.5px] text-ink-secondary hover:bg-control hover:text-ink">{t("engineConnect.commands")}</button>
      {footer && <button type="button" data-engine-connect-primary onClick={footer.open} disabled={footer.disabled} className="rounded-xl bg-accent px-4 py-2.5 text-[13px] font-semibold text-accent-ink hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40">{t(footer.label ?? "onboarding.openOrbit")}</button>}
    </div>
  </div>;
}
