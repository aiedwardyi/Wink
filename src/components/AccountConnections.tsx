import { useState, type ReactNode } from "react";
import { api, type InstanceInfo } from "@/state/store";
import { accountReady, type UsageAccount } from "@/lib/accounts";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { isPhone } from "@/lib/phone-swipe";
import { EngineMark } from "./EngineMark";
import { useEngineSignIn } from "./EngineSetup";
import { ROW_BUTTON } from "./SettingsPrimitives";

// A break chance after "@" lets a long email wrap on a phone instead of being cut off.
function accountLabel(account: UsageAccount) {
  const label = account.snapshot.account || account.displayName;
  const at = label.indexOf("@") + 1;
  return at ? <>{label.slice(0, at)}<wbr />{label.slice(at)}</> : label;
}
const LINE = "flex min-h-9 items-center [@media(pointer:coarse)]:min-h-11";
const STRONG_BUTTON = cn(ROW_BUTTON, "text-ink");

// The mark column keeps its width when empty, so account rows and sign-in steps sit under the engine name.
export function ConnectionRow({ mark, label, actions, children }: { mark?: ReactNode; label: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="min-w-0 break-keep text-[12px] text-ink-secondary">
      <div className="flex items-start gap-2">
        <span className={`${LINE} w-4 shrink-0`}>{mark}</span>
        <div className={`${LINE} min-w-0 flex-1 gap-2`}>{label}</div>
        {actions && <div className={`${LINE} max-w-[65%] shrink-0 justify-end gap-2`}>{actions}</div>}
      </div>
      {children && <div className="flex min-w-0 flex-col items-stretch gap-2 pb-2 pl-6">{children}</div>}
    </div>
  );
}

// Engine rows keep their name and show the step under it; account rows show the step in place of "Signed out.".
export function SignInRow({ instance, mark, name, after, onUpdated }: { instance: InstanceInfo; mark?: ReactNode; name?: ReactNode; after?: ReactNode; onUpdated?: (instance: InstanceInfo) => void }) {
  const { t } = useI18n();
  const { connected, loading, computerOnly, deviceFlow, waiting, failed, capture, copyFallback, busy, loginCode, setLoginCode, start, cancel, submitCode } = useEngineSignIn(instance, onUpdated);
  const status = waiting ? t(copyFallback ? "engine.pasteAndEnter" : capture.code ? "engines.enterCode" : "engines.finishInBrowser")
    : failed ? t("engines.didntFinish") : "";
  const steps = waiting && (copyFallback || capture.code || capture.inputGeneration || failed);
  return (
    <div aria-live="polite">
      <ConnectionRow mark={mark}
        label={name ?? (!loading && <><span className="min-w-0 break-words">{connected ? t("connections.connected") : status || t("accounts.signedOut")}</span>{after}</>)}
        actions={<>{loading || connected ? null : computerOnly ? <span>{t("engines.signInFromComputer")}</span> : waiting ? <>
          {capture.url && <a href={capture.url} target="_blank" rel="noreferrer" className={STRONG_BUTTON}>{t(deviceFlow ? "engines.openLink" : "engines.openAgain")}</a>}
          <button type="button" onClick={() => void cancel()} disabled={busy} className={ROW_BUTTON}>{t("engines.cancel")}</button>
        </> : <button type="button" disabled={busy} onClick={() => void start()} className={STRONG_BUTTON}>{t("engines.signIn")}</button>}</>}>
        {(name && status || steps) && <>
          {name && status && <span>{status}</span>}
          {waiting && copyFallback && <code className="select-all break-all font-mono text-ink">{instance.install?.signInCommand}</code>}
          {waiting && capture.code && <code className="select-all break-all font-mono text-[14px] text-ink">{capture.code}</code>}
          {waiting && capture.inputGeneration && <form className="flex flex-wrap items-center gap-x-3 gap-y-2" onSubmit={(event) => { event.preventDefault(); void submitCode(); }}>
            <input type="password" value={loginCode} onInput={(event) => setLoginCode(event.currentTarget.value)}
              aria-label={t("accounts.loginCode")} placeholder={t("accounts.loginCode")} autoComplete="off" maxLength={4096}
              className="h-8 min-w-0 flex-1 basis-56 rounded border border-hairline bg-control px-2 text-ink [@media(pointer:coarse)]:h-11" />
            <button type="submit" disabled={busy || !loginCode} className={cn(STRONG_BUTTON, "ml-auto")}>{t("accounts.submitCode")}</button>
          </form>}
          {waiting && failed && <span>{t("engines.didntFinish")}</span>}
        </>}
      </ConnectionRow>
    </div>
  );
}

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
  // Add Account closes the group's list, so it never reads as an action on the first account.
  const add = accounts.length < 8 && accounts.some(accountReady) && (computerOnly ? <span>{t("engines.signInFromComputer")}</span>
    : <button type="button" disabled={busy} onClick={() => void mutate("/api/accounts", { of: base, device: !window.ogb && Boolean(login?.deviceArgs) })}
      className={STRONG_BUTTON}>{t("accounts.add")}</button>);
  return (
    <div data-engine-row={base} className="min-w-0 py-1.5">
      {accounts.map((account) => {
        const drain = account.drain;
        const main = accounts.length > 1 && (account.accountMain ?? account.instanceId === base);
        const hasDestination = accounts.some((other) => other !== account && accountReady(other));
        const loading = account.snapshot.authenticated === undefined && !account.loginState;
        const tag = main && <span className="ml-2 inline-block text-[12px] text-ink-secondary">{t("accounts.main")}</span>;
        const mark = <EngineMark instance={account} size={16} tapToShow />;
        if (!accountReady(account) && !drain) return <SignInRow key={account.instanceId} instance={account} mark={mark} after={tag} onUpdated={() => void reload()} />;
        return (
          <ConnectionRow key={account.instanceId} mark={mark}
            label={<>{accountReady(account) ? <span className="min-w-0 break-words text-[13px] text-ink">{accountLabel(account)}{tag}</span>
              : !loading && <span>{t("accounts.signedOut")}{tag}</span>}</>}
            actions={drain && drain.phase !== "failed" ? <span role="status">{t("accounts.removing")}</span>
              : <button type="button" disabled={busy || (main && !hasDestination && !drain)}
                onClick={() => void mutate(`/api/accounts/${encodeURIComponent(account.instanceId)}/sign-out`, drain ? { destinationId: drain.destinationId } : {}, main && !drain ? account.instanceId : undefined)}
                className={ROW_BUTTON}>{t(drain ? "accounts.retrySignOut" : "engines.signOut")}</button>} />
        );
      })}
      {add && <div className={`${LINE} justify-end text-[12px] text-ink-secondary`}>{add}</div>}
      {error && <div role="alert" className="pl-7 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
