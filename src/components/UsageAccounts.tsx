import { useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { api } from "@/state/store";
import { accountReady, type UsageAccount } from "@/lib/accounts";
import { useI18n } from "@/lib/i18n";
import { EngineMark } from "./EngineMark";

export function UsageAccounts({ accounts, reload, renderRow }: {
  accounts: UsageAccount[];
  reload: () => Promise<void>;
  renderRow: (account: UsageAccount, heading?: ReactNode) => ReactNode;
}) {
  const { t } = useI18n();
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  if (accounts.length === 1) return renderRow(accounts[0]!);
  const main = accounts.find((account) => account.accountInfo?.default)
    ?? accounts.find((account) => account.instanceId === account.accountInfo?.of) ?? accounts[0]!;
  const others = accounts.filter((account) => account !== main);
  const index = Math.min(page, others.length - 1);
  const setAsMain = async (account: UsageAccount) => {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      await api(`/api/accounts/${encodeURIComponent(account.instanceId)}/default`, { method: "POST", body: "{}" });
      await reload();
      setPage(0);
    } catch { setError(true); }
    finally { setBusy(false); }
  };
  const arrows = others.length > 1 && (
    <span className="ml-auto flex shrink-0 items-center">
      <button type="button" aria-label={t("accounts.previous")} disabled={index === 0}
        onClick={() => setPage(index - 1)} className="flex size-7 items-center justify-center text-ink-secondary hover:text-ink disabled:opacity-30 [@media(pointer:coarse)]:size-11">
        <ChevronLeft size={15} aria-hidden="true" />
      </button>
      <button type="button" aria-label={t("accounts.next")} disabled={index === others.length - 1}
        onClick={() => setPage(index + 1)} className="flex size-7 items-center justify-center text-ink-secondary hover:text-ink disabled:opacity-30 [@media(pointer:coarse)]:size-11">
        <ChevronRight size={15} aria-hidden="true" />
      </button>
    </span>
  );
  const heading = (account: UsageAccount, other = false) => (
    <div className="flex min-h-7 items-center gap-2 text-[13px] font-medium text-ink">
      <EngineMark instance={account} size={16} tapToShow />
      {other ? arrows : <span>{account.displayName}</span>}
    </div>
  );
  const column = (account: UsageAccount, other = false) => (
    <div className="min-w-0">
      {accountReady(account) ? renderRow(account, heading(account, other)) : <>
        {heading(account, other)}
        <div className="mt-2 text-[12px] text-ink-secondary">{t("accounts.signedOut")}</div>
      </>}
      {other && accountReady(account) && <button type="button" disabled={busy} onClick={() => void setAsMain(account)}
        className="mt-2 text-[12px] text-ink hover:underline disabled:opacity-50 [@media(pointer:coarse)]:min-h-11">{t("accounts.setAsMain")}</button>}
    </div>
  );
  return (
    <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
      <div data-account-column="main">{column(main)}</div>
      <div className="grid min-w-0" data-account-column="other">
        {others.map((account, i) => <div key={account.instanceId} className="col-start-1 row-start-1 min-w-0"
          style={i === index ? undefined : { visibility: "hidden" }} inert={i !== index} aria-hidden={i !== index || undefined}>
          {column(account, true)}
        </div>)}
      </div>
      {error && <div role="alert" className="text-[12px] text-danger sm:col-span-2">{t("engines.didntFinish")}</div>}
    </div>
  );
}
