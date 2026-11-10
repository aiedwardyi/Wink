import { useEffect, useState } from "react";

import { api, useOptionalStoreDispatch, useStore, type InstanceInfo } from "@/state/store";
import { EngineMark } from "./EngineMark";
import { AccountConnections, AccountHead, ConnectionRow, SignInRow } from "./AccountConnections";
import { ROW_BUTTON } from "./SettingsPrimitives";
import { groupAccounts } from "@/lib/accounts";
import { cn } from "@/lib/cn";
import { installCommandFor, installSignsIn, openEngineInstallOrCopy } from "./EngineSetup";
import { isFriendsCliEngine, orderFriendsEngines } from "@/lib/engine-rail";
import { useI18n } from "@/lib/i18n";
import { isTerminalSkin, useSkin } from "@/lib/skins";
import { Fold } from "./Fold";
import { ACCOUNT_ROW, AccountGroup } from "./UsageDesk";

export function isEngineConnected(instance: Pick<InstanceInfo, "snapshot">): boolean {
  return instance.snapshot.state === "available" && instance.snapshot.authenticated === true;
}

export function EngineRow({ instance, onConnected, onUpdated }: { instance: InstanceInfo; onConnected?: () => void; onUpdated?: (instance: InstanceInfo) => void }) {
  const { t } = useI18n();
  const dispatch = useOptionalStoreDispatch();
  const terminal = isTerminalSkin(useSkin());
  const [current, setCurrent] = useState(instance);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [installStatus, setInstallStatus] = useState<"running" | "opened" | "copied" | "failed" | null>(null);
  useEffect(() => { setCurrent(instance); }, [instance]);
  const signOut = async () => {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      await api(`/api/instances/${encodeURIComponent(instance.instanceId)}/sign-out`, { method: "POST", body: "{}" });
      const { instances } = await api("/api/instances?refresh=1");
      dispatch?.({ type: "instances", instances, preserveRateLimits: true });
      const next = (instances as InstanceInfo[]).find((row) => row.instanceId === instance.instanceId);
      if (next) { setCurrent(next); onUpdated?.(next); }
    } catch { setError(true); }
    finally { setBusy(false); }
  };
  const canSignOut = Boolean(current.install?.logout) && current.driverKind !== "antigravityAgent";
  const installCommand = current.snapshot.state !== "available" ? installCommandFor(current.install) : null;
  const install = async () => {
    if (!installCommand || busy) return;
    setBusy(true);
    setInstallStatus(null);
    try {
      setInstallStatus(await openEngineInstallOrCopy(current.instanceId, installCommand));
    } catch { setInstallStatus("failed"); }
    finally { setBusy(false); }
  };
  const mark = <EngineMark instance={current} size={16} />;
  const name = <span className="min-w-0 break-words text-[14px] font-semibold text-ink">{current.displayName}</span>;
  return (
    <div data-engine-row={current.instanceId} className="min-w-0">
      {current.snapshot.state !== "available" ? (
        <ConnectionRow mark={mark} label={name} actions={
          <div className="flex flex-wrap items-center justify-end gap-x-3">
            <span aria-live="polite">{installStatus === "opened" || installStatus === "running" ? t("engine.terminalOpened")
              : installStatus === "copied" ? t("engine.commandCopied")
                : installStatus === "failed" && !current.install?.docsUrl ? t("engines.installFailed") : t("engines.notInstalled")}</span>
            {installCommand && !(installStatus === "failed" && current.install?.docsUrl) ? <button type="button" onClick={() => void install()} disabled={busy}
              className={cn(ROW_BUTTON, "text-ink")}>{t("engines.install")}</button>
              : current.install?.docsUrl && <a href={current.install.docsUrl} target="_blank" rel="noreferrer"
              className={cn(ROW_BUTTON, "text-ink")}>{t("engines.install")}</a>}
            {(installStatus === "opened" || installStatus === "running") && (
              <p className="w-full text-right text-[11px] leading-[14px] text-ink-secondary/70">{t(installStatus !== "running" ? "engine.pasteAndEnter" : installSignsIn(current.install) ? "engine.followSignIn" : "engine.installRunning")}</p>
            )}
            {current.install?.needsNode && installCommand?.includes("npm") && !(window.ogb?.openEngineInstall && window.ogb.platform === "win32") && (
              <p className="w-full text-right text-[11px] leading-[14px] text-ink-secondary/70">{t("engine.needsNode")}</p>
            )}
          </div>} />
      ) : isEngineConnected(current) ? <>
        <ConnectionRow mark={mark} label={name} />
        <AccountGroup label={current.displayName} terminal={terminal}>
          <div data-account-row={current.instanceId} className={ACCOUNT_ROW}>
            <AccountHead name={<span className="min-w-0 truncate">{current.displayName}</span>} email={current.snapshot.account}
              control={canSignOut ? <button type="button" onClick={() => void signOut()} disabled={busy} className={ROW_BUTTON}>{t("engines.signOut")}</button>
                : <span>{t("connections.connected")}</span>} />
          </div>
        </AccountGroup>
        {error && <div role="alert" className="mt-2 text-[12px] text-ink-secondary">{t("engines.didntFinish")}</div>}
      </> : (
        <SignInRow instance={current} mark={mark} name={name} onUpdated={(next) => {
          setCurrent(next);
          if (next.snapshot.authenticated === true) onConnected?.();
        }} />
      )}
    </div>
  );
}

export function EnginesSettings() {
  const { t } = useI18n();
  const { state, refreshInstances } = useStore();
  const groups = groupAccounts(state.instances);
  const reload = refreshInstances;
  const [showAll, setShowAll] = useState(false);
  // Same guard as the store's focus probe: a rescan can flash a window that
  // steals focus, so only a real trip away (a terminal sign-in) rescans.
  useEffect(() => {
    const AWAY_MS = 5000;
    let blurredAt = 0;
    let quietUntil = 0;
    const rescan = () => {
      quietUntil = Infinity;
      void refreshInstances(true).finally(() => {
        quietUntil = Date.now() + AWAY_MS;
      });
    };
    const onBlur = () => {
      const now = Date.now();
      blurredAt = now < quietUntil ? 0 : now;
    };
    const onFocus = () => {
      const away = blurredAt > 0 && Date.now() - blurredAt >= AWAY_MS;
      blurredAt = 0;
      if (away) rescan();
    };
    rescan();
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshInstances]);
  const rows = orderFriendsEngines(groups.map((accounts) => accounts[0]!).filter(isFriendsCliEngine));
  const installed = rows.filter((row) => row.snapshot.state === "available");
  const missing = rows.filter((row) => row.snapshot.state !== "available");
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {rows.length === 0 && <p className="text-[13px] text-ink-secondary">{t("engines.none")}</p>}
      {installed.map((instance) => {
        const accounts = groups.find((group) => group[0] === instance)!;
        return ["claudeAgent", "codex"].includes(instance.driverKind) ? <AccountConnections key={instance.instanceId} accounts={accounts} reload={reload} />
          : <EngineRow key={instance.instanceId} instance={instance} />;
      })}
      {missing.length > 0 && <>
        <button type="button" onClick={() => setShowAll(!showAll)} aria-expanded={showAll}
          className={cn(ROW_BUTTON, "self-start")}>{t("engines.moreEngines")}</button>
        <Fold open={showAll}>
          <div className="flex min-w-0 flex-col gap-4">
            {missing.map((instance) => <EngineRow key={instance.instanceId} instance={instance} />)}
          </div>
        </Fold>
      </>}
    </div>
  );
}
