import { useCallback, useEffect, useState } from "react";
import { api, useStore } from "@/state/store";
import { accountReady, type UsageAccount } from "@/lib/accounts";
import { useI18n } from "@/lib/i18n";
import { EngineMark } from "./EngineMark";
import { EngineSignIn } from "./EngineSetup";

export function AccountConnections({ accounts, reload }: { accounts: UsageAccount[]; reload: () => Promise<void> }) {
  const { t } = useI18n();
  const { state, refreshInstances } = useStore();
  const [removing, setRemoving] = useState<string | null>(null);
  const [destination, setDestination] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const base = accounts[0]!.accountInfo?.of ?? accounts[0]!.instanceId;
  const main = accounts.find((account) => account.accountInfo?.default) ?? accounts.find((account) => account.instanceId === base);
  const count = state.bots.filter((bot) => bot.modelSelection.instanceId === base).length;
  const draining = accounts.some((account) => account.accountInfo?.drain && account.accountInfo.drain.phase !== "failed");
  const update = useCallback(async () => {
    await refreshInstances();
    await reload();
  }, [refreshInstances, reload]);
  useEffect(() => {
    if (!draining) return;
    const timer = window.setInterval(() => { void update().catch(() => setError(true)); }, 1500);
    return () => window.clearInterval(timer);
  }, [draining, update]);
  const mutate = async (path: string, body: object) => {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      await api(path, { method: "POST", body: JSON.stringify(body) });
      setRemoving(null);
      await update();
    } catch { setError(true); }
    finally { setBusy(false); }
  };
  return (
    <div data-engine-row={base} className="min-w-0 py-2">
      <div className="py-1.5 text-[13px] text-ink">{accounts[0]!.displayName}</div>
      {accounts.map((account) => {
        const destinations = accounts.filter((other) => other !== account && accountReady(other));
        const drain = account.accountInfo?.drain;
        const used = account === main ? count : 0;
        return (
          <div key={account.instanceId} className="py-1">
            <div className="flex min-h-11 items-center gap-3 text-[12px] text-ink-secondary">
              <EngineMark instance={account} size={16} tapToShow />
              <span>{t(accountReady(account) ? "connections.connected" : "accounts.signedOut")}</span>
              <div className="ml-auto">
                {drain && drain.phase !== "failed" ? <span role="status">{t("accounts.removing")}</span>
                  : !accountReady(account) && !drain ? <EngineSignIn instance={account} onUpdated={() => void update()} />
                    : removing !== account.instanceId && <button type="button" disabled={busy} onClick={() => {
                      setRemoving(account.instanceId);
                      setDestination(destinations[0]?.instanceId ?? "");
                      setError(false);
                    }} className="min-h-11 text-ink hover:underline disabled:opacity-50">{t("engines.signOut")}</button>}
              </div>
            </div>
            {removing === account.instanceId && <div className="flex flex-col items-end gap-2 text-[12px] text-ink-secondary">
              {used > 0 && <span>{t(used === 1 ? "accounts.moveBot" : "accounts.moveBots", { count: used })}</span>}
              {destinations.length > 0 && <div role="radiogroup" aria-label={t("accounts.destination")} className="flex flex-wrap items-center gap-3">
                {destinations.map((other) => <label key={other.instanceId} className="flex min-h-11 cursor-pointer items-center gap-2">
                  <input type="radio" name={`move-${account.instanceId}`} checked={destination === other.instanceId}
                    onChange={() => setDestination(other.instanceId)} aria-label={other.displayName} />
                  <EngineMark instance={other} size={16} tapToShow />
                </label>)}
              </div>}
              <div className="flex items-center gap-4">
                <button type="button" disabled={busy} onClick={() => setRemoving(null)} className="min-h-11 text-ink hover:underline">{t("engines.cancel")}</button>
                <button type="button" disabled={busy || (used > 0 && !destination)}
                  onClick={() => void mutate(`/api/accounts/${encodeURIComponent(account.instanceId)}/sign-out`, destination ? { destinationId: destination } : {})}
                  className="min-h-11 text-danger hover:underline disabled:opacity-50">{t(destination ? "accounts.moveAndSignOut" : "engines.signOut")}</button>
              </div>
            </div>}
          </div>
        );
      })}
      {accounts.length < 8 && <button type="button" disabled={busy} onClick={() => void mutate("/api/accounts", { of: base, device: !window.ogb })}
        className="min-h-11 text-[12px] text-ink hover:underline disabled:opacity-50">{t("accounts.add")}</button>}
      {error && <div role="alert" className="text-[12px] text-danger">{t("engines.didntFinish")}</div>}
    </div>
  );
}
