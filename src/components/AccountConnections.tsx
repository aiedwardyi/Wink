import { useCallback, useEffect, useState } from "react";
import { api, useStore } from "@/state/store";
import { accountReady, type UsageAccount } from "@/lib/accounts";
import { useI18n } from "@/lib/i18n";
import { EngineMark } from "./EngineMark";
import { EngineSignIn } from "./EngineSetup";

const accountLabel = (account: UsageAccount) => account.snapshot.account || account.displayName;

export function AccountConnections({ accounts, reload }: { accounts: UsageAccount[]; reload: () => Promise<void> }) {
  const { t } = useI18n();
  const { refreshInstances } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const base = accounts[0]!.accountInfo?.of ?? accounts[0]!.instanceId;
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
      await update();
    } catch { setError(true); }
    finally { setBusy(false); }
  };
  return (
    <div data-engine-row={base} className="min-w-0 py-2">
      <div className="py-1.5 text-[13px] text-ink">{accounts[0]!.displayName}</div>
      {accounts.map((account) => {
        const drain = account.accountInfo?.drain;
        return (
          <div key={account.instanceId} className="py-1">
            <div className="flex min-h-11 min-w-0 items-center gap-3 text-[12px] text-ink-secondary">
              <EngineMark instance={account} size={16} tapToShow />
              <span className="min-w-0 flex-1 truncate" title={accountReady(account) ? accountLabel(account) : undefined}>
                {accountReady(account) ? accountLabel(account) : t("accounts.signedOut")}
              </span>
              <div className="ml-auto shrink-0">
                {drain && drain.phase !== "failed" ? <span role="status">{t("accounts.removing")}</span>
                  : !accountReady(account) && !drain ? <EngineSignIn instance={account} onUpdated={() => void update()} />
                    : <button type="button" disabled={busy}
                      onClick={() => void mutate(`/api/accounts/${encodeURIComponent(account.instanceId)}/sign-out`, {})}
                      className="min-h-11 text-ink hover:underline disabled:opacity-50">{t("engines.signOut")}</button>}
              </div>
            </div>
          </div>
        );
      })}
      {accounts.length < 8 && <button type="button" disabled={busy} onClick={() => void mutate("/api/accounts", { of: base, device: !window.ogb })}
        className="min-h-11 text-[12px] text-ink hover:underline disabled:opacity-50">{t("accounts.add")}</button>}
      {error && <div role="alert" className="text-[12px] text-danger">{t("engines.didntFinish")}</div>}
    </div>
  );
}
