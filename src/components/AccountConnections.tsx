import { useState } from "react";
import { api } from "@/state/store";
import { accountReady, type UsageAccount } from "@/lib/accounts";
import { useI18n } from "@/lib/i18n";
import { isPhone } from "@/lib/phone-swipe";
import { EngineMark } from "./EngineMark";
import { EngineSignIn } from "./EngineSetup";

const accountLabel = (account: UsageAccount) => account.snapshot.account || account.displayName;

export function AccountConnections({ accounts, reload }: { accounts: UsageAccount[]; reload: () => Promise<void> }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const base = accounts[0]!.accountOf ?? accounts[0]!.instanceId;
  const login = accounts[0]!.install?.login;
  const computerOnly = !window.ogb && isPhone() && !login?.deviceArgs;
  const mutate = async (path: string, body: object, sourceId?: string) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (sourceId) body = await api(`/api/accounts/${encodeURIComponent(sourceId)}/destination`);
      await api(path, { method: "POST", body: JSON.stringify(body) });
      await reload();
    } catch (error) {
      setError(error instanceof Error && error.message === "No ready account can take over this profile"
        ? t("accounts.noDestination") : error instanceof Error && error.message || t("engines.didntFinish"));
    }
    finally { setBusy(false); }
  };
  return (
    <div data-engine-row={base} className="min-w-0 py-2">
      <div className="py-1.5 text-[13px] text-ink">{accounts[0]!.displayName}</div>
      {accounts.map((account) => {
        const drain = account.drain;
        const main = accounts.length > 1 && (account.accountMain ?? account.instanceId === base);
        const hasDestination = accounts.some((other) => other !== account && accountReady(other));
        const loading = account.snapshot.authenticated === undefined && !account.loginState;
        return (
          <div key={account.instanceId} className="py-1">
            <div className="flex min-h-11 min-w-0 items-center gap-3 text-[12px] text-ink-secondary">
              <EngineMark instance={account} size={16} tapToShow />
              <span className="min-w-0 flex-1 truncate" title={accountReady(account) ? accountLabel(account) : undefined}>
                {accountReady(account) ? accountLabel(account) : loading ? null : t("accounts.signedOut")}
              </span>
              {main && <span className="shrink-0 rounded border border-hairline px-1.5 py-0.5 text-[11px]">{t("accounts.main")}</span>}
              <div className="ml-auto shrink-0">
                {drain && drain.phase !== "failed" ? <span role="status">{t("accounts.removing")}</span>
                  : !accountReady(account) && !drain ? <EngineSignIn instance={account} onUpdated={() => void reload()} />
                    : <button type="button" disabled={busy || (main && !hasDestination && !drain)}
                      onClick={() => void mutate(`/api/accounts/${encodeURIComponent(account.instanceId)}/sign-out`, drain ? { destinationId: drain.destinationId } : {}, main && !drain ? account.instanceId : undefined)}
                      className="min-h-11 text-ink hover:underline disabled:opacity-50">{t(drain ? "accounts.retrySignOut" : "engines.signOut")}</button>}
              </div>
            </div>
          </div>
        );
      })}
      {accounts.length < 8 && <div className="min-h-11">
        {accounts.some(accountReady) && (computerOnly ? <span className="text-[12px] text-ink-secondary">{t("engines.signInFromComputer")}</span>
        : <button type="button" disabled={busy} onClick={() => void mutate("/api/accounts", { of: base, device: !window.ogb && Boolean(login?.deviceArgs) })}
          className="min-h-11 text-[12px] text-ink hover:underline disabled:opacity-50">{t("accounts.add")}</button>)}
      </div>}
      {error && <div role="alert" className="text-[12px] text-danger">{error}</div>}
    </div>
  );
}
