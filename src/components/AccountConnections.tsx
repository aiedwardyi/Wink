import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Ellipsis } from "lucide-react";
import { api, type InstanceInfo } from "@/state/store";
import { accountReady, type UsageAccount } from "@/lib/accounts";
import { cn } from "@/lib/cn";
import { afterFold } from "@/lib/fold-press";
import { useI18n } from "@/lib/i18n";
import { isPhone } from "@/lib/phone-swipe";
import { safeProviderText } from "@/lib/safe-provider-text";
import { isTerminalSkin, useSkin } from "@/lib/skins";
import type { UsageBoardAccount } from "@/lib/usage-board";
import { useUsageBoard } from "@/lib/use-usage-board";
import { useIsPhone } from "@/lib/use-phone-swipe";
import { AccountNameEditor, type SavedAccountName } from "./AccountNameEditor";
import { Fold } from "./Fold";
import { useEngineSignIn } from "./EngineSetup";
import { ProviderMark } from "./ProviderIcons";
import { ROW_BUTTON } from "./SettingsPrimitives";
import { Tile } from "./UsageDesk";

const LINE = "flex min-h-9 items-center [@media(pointer:coarse)]:min-h-11";
const STRONG_BUTTON = cn(ROW_BUTTON, "text-ink");

export function ConnectionRow({ mark, label, actions, children }: { mark?: ReactNode; label: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="min-w-0 break-keep text-[12px] text-ink-secondary">
      <div className="flex items-start gap-2">
        <span className={`${LINE} w-4 shrink-0`}>{mark}</span>
        <div className={`${LINE} min-w-0 flex-1 gap-2`}>{label}</div>
        {actions && <div className={`${LINE} max-w-[65%] shrink-0 justify-end gap-2 whitespace-nowrap`}>{actions}</div>}
      </div>
      {children && <div className="flex min-w-0 flex-col items-stretch gap-2 pb-2 pl-6 has-[>[hidden]]:pb-0">{children}</div>}
    </div>
  );
}

export function SignInRow({ instance, mark, name, after, onUpdated }: { instance: InstanceInfo; mark?: ReactNode; name?: ReactNode; after?: ReactNode; onUpdated?: (instance: InstanceInfo) => void }) {
  const { t } = useI18n();
  const { connected, loading, computerOnly, deviceFlow, waiting, failed, capture, copyFallback, busy, loginCode, setLoginCode, start, cancel, submitCode } = useEngineSignIn(instance, onUpdated);
  const status = waiting ? t(copyFallback ? "engine.pasteAndEnter" : capture.code ? "engines.enterCode" : "engines.finishInBrowser")
    : failed ? t("engines.didntFinish") : "";
  const steps = waiting && (copyFallback || capture.code || capture.inputGeneration || failed);
  const elsewhere = computerOnly && !loading && !connected;
  return (
    <div aria-live="polite">
      <ConnectionRow mark={mark}
        label={name ?? (!loading && <><span className="min-w-0 break-words">{connected ? t("connections.connected") : status || t("accounts.signedOut")}</span>{after}</>)}
        actions={<>{loading || connected || computerOnly ? null : waiting ? <>
          {capture.url && <a href={capture.url} target="_blank" rel="noreferrer" className={STRONG_BUTTON}>{t(deviceFlow ? "engines.openLink" : "engines.openAgain")}</a>}
          <button type="button" onClick={() => void cancel()} disabled={busy} className={ROW_BUTTON}>{t("engines.cancel")}</button>
        </> : <button type="button" disabled={busy} onClick={() => void start()} className={STRONG_BUTTON}>{t("engines.signIn")}</button>}</>}>
        {(elsewhere || name && status || steps) && <>
          {elsewhere && <span>{t("engines.signInFromComputer")}</span>}
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

function ConnectionAccount({ account, label, named, revision, busy, disabled, signOut, reload }: {
  account: UsageAccount;
  label: string;
  named?: UsageBoardAccount;
  revision: number;
  busy: boolean;
  disabled: boolean;
  signOut: () => void;
  reload: () => Promise<void>;
}) {
  const { t } = useI18n();
  const phone = useIsPhone();
  const terminal = isTerminalSkin(useSkin());
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState<(SavedAccountName & { revision: number }) | null>(null);
  const version = useRef(revision);
  version.current = revision;
  const nameButton = useRef<HTMLButtonElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const actions = useRef<HTMLDivElement>(null);
  const name = named && saved && saved.revision >= revision ? saved : named;
  const ready = accountReady(account);
  const canName = Boolean(named) && ["claudeAgent", "codex"].includes(account.driverKind);
  useEffect(() => {
    if (!menu) return;
    actions.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !actions.current?.contains(event.target) && !menuButton.current?.contains(event.target)) setMenu(false);
    };
    window.addEventListener("pointerdown", outside, true);
    return () => window.removeEventListener("pointerdown", outside, true);
  }, [menu]);
  const closeEditor = () => { setEditing(false); (phone ? menuButton : nameButton).current?.focus(); };
  const controls = <>
    {canName && <button ref={nameButton} type="button" disabled={busy} className={ROW_BUTTON}
      onClick={() => { setMenu(false); setEditing(true); }}>{t("accounts.name.edit")}</button>}
    {(ready || account.drain?.phase === "failed") && <button type="button" disabled={busy || disabled} onClick={() => { setMenu(false); signOut(); }}
      className={ROW_BUTTON}>{t(account.drain ? "accounts.retrySignOut" : "engines.signOut")}</button>}
  </>;
  const mark = <ProviderMark driverKind={account.driverKind} size={16} />;
  const tile = name && <span data-account-number="" className="shrink-0"><Tile number={name.number} terminal={terminal} /></span>;
  const draining = account.drain && account.drain.phase !== "failed";
  const toggleMenu = () => afterFold(`${id}-actions`, () => setMenu(!menu));
  const more = <button ref={menuButton} type="button" data-connection-menu="" aria-label={t("connections.actions")} aria-expanded={menu} aria-controls={`${id}-actions`}
    onClick={toggleMenu} className={ROW_BUTTON}><Ellipsis size={14} aria-hidden="true" /></button>;
  // On a phone the address gets its own line under the tile, running under the more button, so a 30-character email shows whole.
  const stacked = phone && name && !draining;
  return (
    <div data-connection-account={account.instanceId} className="relative min-w-0">
      {!ready && !account.drain ? <>
        <SignInRow instance={account} mark={mark} onUpdated={() => void reload()} />
        {name && <ConnectionRow label={<>
          {tile}
          <span className="min-w-0 truncate">{name.name}</span>
        </>} actions={canName ? phone ? <button ref={menuButton} type="button" data-connection-menu="" aria-label={t("connections.actions")} aria-expanded={menu}
          onClick={toggleMenu} className={ROW_BUTTON}><Ellipsis size={14} aria-hidden="true" /></button> : controls : undefined} />}
      </> : <ConnectionRow mark={mark}
        label={<>
          {!stacked && tile}
          <button type="button" data-connection-identity="" aria-label={t("connections.identity")} aria-expanded={expanded} aria-controls={`${id}-identity`}
            onClick={() => afterFold(`${id}-identity`, () => setExpanded(!expanded))} className={cn("flex min-w-0 flex-1 text-left text-[13px]", stacked ? "flex-col pb-2" : "h-9 items-center gap-2 [@media(pointer:coarse)]:h-11")}>
            {stacked ? <span className="flex h-9 min-w-0 items-center gap-2 pr-10 [@media(pointer:coarse)]:h-11">{tile}<span className="min-w-0 truncate text-ink">{name.name}</span></span>
              : name && <span className="max-w-[40%] shrink truncate text-ink">{name.name}</span>}
            <span className={cn("min-w-0 truncate text-ink-secondary", stacked ? "-mt-1.5" : "flex-1")}>{label}</span>
          </button>
        </>}
        actions={draining ? <span role="status">{t("accounts.removing")}</span> : stacked ? undefined : phone ? more : controls}>
        <Fold open={expanded} id={`${id}-identity`}>
          <div data-connection-identity-body="" className="py-1 text-[13px] text-ink">{name && <div className="truncate">{name.name}</div>}<div className="truncate">{label}</div></div>
        </Fold>
      </ConnectionRow>}
      {stacked && <span className="absolute right-0 top-0 flex h-9 items-center [@media(pointer:coarse)]:h-11">{more}</span>}
      <Fold open={menu} id={`${id}-actions`}>
        <div ref={actions} className="flex min-w-0 flex-wrap justify-end gap-2 pb-2 pl-6"
          onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setMenu(false); menuButton.current?.focus(); } }}>
          {controls}
        </div>
      </Fold>
      {editing && named && <div className="pl-6"><AccountNameEditor id={account.instanceId} nickname={name?.nickname ?? null}
        onSaved={(next) => setSaved({ ...next, revision: version.current })} onClose={closeEditor} /></div>}
    </div>
  );
}

export function AccountConnections({ accounts, reload }: { accounts: UsageAccount[]; reload: () => Promise<void> }) {
  const { t } = useI18n();
  const { board } = useUsageBoard();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; signInIds: string[] } | null>(null);
  useEffect(() => {
    if (error?.signInIds.length && !accounts.some((account) => error.signInIds.includes(account.instanceId)
      && !accountReady(account) && (account.loginState === "pending" || !account.loginState && account.accountState === "pending"))) setError(null);
  }, [accounts, error]);
  const base = accounts[0]!.accountOf ?? accounts[0]!.instanceId;
  const login = accounts[0]!.install?.login;
  const computerOnly = !window.ogb && isPhone() && !login?.deviceArgs;
  const mutate = async (path: string, body: object, sourceId?: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (sourceId) body = await api(`/api/accounts/${encodeURIComponent(sourceId)}/destination`);
      await api(path, { method: "POST", body: JSON.stringify(body) });
      await reload();
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const signInIds = ["Sign-in is already in progress", "Another sign-in for this engine is still running"].includes(message)
        ? accounts.filter((account) => !accountReady(account) && (account.loginState === "pending" || !account.loginState && account.accountState === "pending")).map((account) => account.instanceId) : [];
      setError({ message: message === "No ready account can take over this profile"
        ? t("accounts.noDestination") : safeProviderText(message, accounts.map((account) => account.snapshot.account)) || t("engines.didntFinish"), signInIds });
    }
    finally { setBusy(false); }
  };
  const addable = accounts.length < 8 && accounts.some(accountReady);
  const add = addable && !computerOnly && <button type="button" disabled={busy} onClick={() => void mutate("/api/accounts", { of: base, device: !window.ogb && Boolean(login?.deviceArgs) })}
    className={STRONG_BUTTON}>{t("accounts.add")}</button>;
  return (
    <div data-engine-row={base} className="min-w-0 py-1.5">
      <ConnectionRow mark={<ProviderMark driverKind={accounts[0]!.driverKind} size={16} />}
        label={<span className="min-w-0 truncate text-[13px] text-ink">{accounts[0]!.displayName}</span>} actions={add || undefined}>
        {addable && computerOnly && <span>{t("engines.signInFromComputer")}</span>}
      </ConnectionRow>
      {accounts.map((account) => {
        const drain = account.drain;
        const main = accounts.length > 1 && (account.accountMain ?? account.instanceId === base);
        const hasDestination = accounts.some((other) => other !== account && accountReady(other));
        return (
          <ConnectionAccount key={account.instanceId} account={account} label={account.snapshot.account || (account.displayName === accounts[0]!.displayName ? t("connections.connected") : account.displayName)} busy={busy} disabled={Boolean(main && !hasDestination && !drain)}
            named={board?.engines.flatMap((engine) => engine.accounts).find((row) => row.id === account.instanceId)} revision={board?.revision ?? -1}
            reload={reload} signOut={() => void mutate(`/api/accounts/${encodeURIComponent(account.instanceId)}/sign-out`, drain ? { destinationId: drain.destinationId } : {}, main && !drain ? account.instanceId : undefined)} />
        );
      })}
      {error && <div role="alert" className="pl-7 text-[12px] text-danger">{error.message}</div>}
    </div>
  );
}
