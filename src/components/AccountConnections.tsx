import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
import { ordered, reorderable, useUsageDrag } from "@/lib/use-usage-drag";
import { AccountNameEditor, type SavedAccountName } from "./AccountNameEditor";
import { Fold } from "./Fold";
import { useEngineSignIn } from "./EngineSetup";
import { ProviderMark } from "./ProviderIcons";
import { ROW_BUTTON } from "./SettingsPrimitives";
import { ACCOUNT_ROW, AccountGroup, Tile } from "./UsageDesk";

const LINE = "flex min-h-7 items-center";
const STRONG_BUTTON = cn(ROW_BUTTON, "text-ink");

function signInPending(account: UsageAccount): boolean {
  return !accountReady(account) && (account.loginState === "pending" || (!account.loginState && account.accountState === "pending"));
}

/** With the engine mark it is the engine's header, its actions the one slot on the right; without, a line inside an account row. */
export function ConnectionRow({ mark, label, actions, children }: { mark?: ReactNode; label: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  const head = Boolean(mark);
  return (
    <div className="min-w-0 break-keep text-[12px] text-ink-secondary">
      <div data-engine-head={head ? "" : undefined} className="flex items-start gap-2">
        {head && <span className={`${LINE} w-4 shrink-0`}>{mark}</span>}
        <div className={`${LINE} min-w-0 flex-1 gap-2`}>{label}</div>
        {actions && <div data-engine-slot={head ? "" : undefined} className={`${LINE} max-w-[65%] shrink-0 justify-end gap-2 whitespace-nowrap`}>{actions}</div>}
      </div>
      <Fold open={Boolean(children)} keep>
        <div className={cn("flex min-w-0 flex-col items-stretch gap-2", head && "pb-2 pl-6 has-[>[hidden]]:pb-0")}>{children}</div>
      </Fold>
    </div>
  );
}

/** Usage's account row head: the name line, the address under it, one control on the right. */
export function AccountHead({ name, email, control }: { name: ReactNode; email?: ReactNode; control?: ReactNode }) {
  return (
    <div data-account-head="" className="usage-account-head">
      <div className="usage-account-identity min-w-0">
        <div className="flex min-w-0 items-center gap-2">{name}</div>
        {email && <span data-account-email="" className="usage-email min-w-0 break-words">{email}</span>}
      </div>
      {control && <div className="usage-control flex h-[22px] items-center justify-end gap-2 whitespace-nowrap text-[12px] text-ink-secondary">{control}</div>}
    </div>
  );
}

export function SignInRow({ instance, mark, name, after, onUpdated }: { instance: InstanceInfo; mark?: ReactNode; name?: ReactNode; after?: ReactNode; onUpdated?: (instance: InstanceInfo) => void }) {
  const { t } = useI18n();
  const { connected, loading, computerOnly, deviceFlow, waiting, failed, capture, copyFallback, busy, loginCode, setLoginCode, start, cancel, submitCode } = useEngineSignIn(instance, onUpdated);
  const status = waiting ? t(copyFallback ? "engine.pasteAndEnter" : capture.code ? "engines.enterCode" : "engines.finishInBrowser")
    : failed ? t(failed) : "";
  const steps = waiting && (copyFallback || capture.code || capture.inputGeneration || failed);
  return (
    <div aria-live="polite">
      <ConnectionRow mark={mark}
        label={name ?? (!loading && <><span className="min-w-0 break-words">{connected ? t("connections.connected") : status || t("accounts.signedOut")}</span>{after}</>)}
        actions={<>{loading || connected ? null : computerOnly ? <span data-computer-only="">{t("engines.signInFromComputer")}</span> : waiting ? <>
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
          {waiting && failed && <span>{t(failed)}</span>}
        </>}
      </ConnectionRow>
    </div>
  );
}

function ConnectionAccount({ account, label, named, revision, busy, disabled, signOut, reload, reorder }: {
  account: UsageAccount;
  label: string;
  named?: UsageBoardAccount;
  revision: number;
  busy: boolean;
  disabled: boolean;
  signOut: () => void;
  reload: () => Promise<void>;
  reorder: boolean;
}) {
  const { t } = useI18n();
  const phone = useIsPhone();
  const terminal = isTerminalSkin(useSkin());
  const id = useId();
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState<(SavedAccountName & { revision: number }) | null>(null);
  const version = useRef(revision);
  version.current = revision;
  const inlineNameButton = useRef<HTMLButtonElement>(null);
  const inlineEditor = useRef(false);
  const restoreFocus = useRef(false);
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
  useLayoutEffect(() => {
    if (!editing && restoreFocus.current) {
      restoreFocus.current = false;
      (inlineEditor.current ? inlineNameButton : menuButton).current?.focus();
    }
  }, [editing, phone]);
  const closeEditor = () => { restoreFocus.current = true; setEditing(false); };
  const controls = <>
    {phone && canName && <button type="button" disabled={busy} className={ROW_BUTTON}
      onClick={() => { inlineEditor.current = false; setMenu(false); setEditing(true); }}>{t("accounts.name.edit")}</button>}
    {(ready || account.drain?.phase === "failed") && <button type="button" disabled={busy || disabled} onClick={() => { setMenu(false); signOut(); }}
      className={ROW_BUTTON}>{t(account.drain ? "accounts.retrySignOut" : "engines.signOut")}</button>}
  </>;
  const tile = name && <span data-account-number="" className="shrink-0"><Tile number={name.number} terminal={terminal} /></span>;
  const draining = account.drain && account.drain.phase !== "failed";
  const signInRow = !ready && !account.drain;
  const toggleMenu = () => afterFold(`${id}-actions`, () => setMenu(!menu));
  const more = <button ref={menuButton} type="button" data-connection-menu="" aria-label={t("connections.actions")} aria-expanded={menu} aria-controls={`${id}-actions`}
    onClick={toggleMenu} className={ROW_BUTTON}><Ellipsis size={14} aria-hidden="true" /></button>;
  // A signed-out row keeps its menu on the name line and Sign In on its own line below, so neither covers the other.
  const control = draining ? <span role="status">{t("accounts.removing")}</span> : signInRow ? phone && canName && more : phone ? more : controls;
  return (
    <div data-connection-account={account.instanceId} data-account-row={account.instanceId} {...(reorder && reorderable(t("usage.desk.reorder", { name: name?.name ?? account.displayName })))} className={ACCOUNT_ROW}>
      {(name || !signInRow) && <AccountHead control={control} email={!signInRow && label} name={<>
        {tile}
        {editing && named ? <AccountNameEditor id={account.instanceId} nickname={name?.nickname ?? null} inline
          onSaved={(next) => setSaved({ ...next, revision: version.current })} onClose={closeEditor} />
          : <button ref={inlineNameButton} type="button" data-edit-name="" disabled={!canName || busy} onClick={() => { inlineEditor.current = true; setEditing(true); }}
            className="min-w-0 max-w-full truncate text-left">{name?.name}</button>}
      </>} />}
      <Fold open={menu} id={`${id}-actions`}>
        <div ref={actions} className="flex min-w-0 flex-wrap justify-end gap-2 pt-2"
          onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setMenu(false); menuButton.current?.focus(); } }}>
          {controls}
        </div>
      </Fold>
      {signInRow && <SignInRow instance={account} onUpdated={() => void reload()} />}
    </div>
  );
}

export function AccountConnections({ accounts, reload }: { accounts: UsageAccount[]; reload: () => Promise<void> }) {
  const { t } = useI18n();
  const { board } = useUsageBoard();
  const terminal = isTerminalSkin(useSkin());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; signInIds: string[] } | null>(null);
  useEffect(() => {
    if (error?.signInIds.length && !accounts.some((account) => error.signInIds.includes(account.instanceId)
      && signInPending(account))) setError(null);
  }, [accounts, error]);
  const base = accounts[0]!.accountOf ?? accounts[0]!.instanceId;
  const drag = useUsageDrag([{ base, accounts: accounts.map((account) => ({ id: account.instanceId })) }]);
  const login = accounts[0]!.install?.login;
  const computerOnly = !window.ogb && isPhone() && !login?.deviceArgs;
  const mutate = async (path: string, body: object, sourceId?: string) => {
    if (busy) return;
    const signInIds = accounts.filter(signInPending).map((account) => account.instanceId);
    setBusy(true);
    setError(null);
    try {
      if (sourceId) body = await api(`/api/accounts/${encodeURIComponent(sourceId)}/destination`);
      await api(path, { method: "POST", body: JSON.stringify(body) });
      await reload();
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      setError({ message: message === "No ready account can take over this profile"
        ? t("accounts.noDestination") : safeProviderText(message, accounts.map((account) => account.snapshot.account)) || t("engines.didntFinish"),
        signInIds: ["Sign-in is already in progress", "Another sign-in for this engine is still running"].includes(message) ? signInIds : [] });
    }
    finally { setBusy(false); }
  };
  const addable = accounts.length < 8 && accounts.some(accountReady);
  const add = addable && (computerOnly ? <span data-computer-only="">{t("connections.addOnComputer")}</span>
    : <button type="button" disabled={busy} onClick={() => void mutate("/api/accounts", { of: base, device: !window.ogb && Boolean(login?.deviceArgs) })}
      className={STRONG_BUTTON}>{t("accounts.add")}</button>);
  return (
    <div data-engine-row={base} data-usage-engine="" data-usage-base={base} ref={drag.ref} onPointerDown={drag.onPointerDown} onKeyDown={drag.onKeyDown} className="min-w-0">
      <ConnectionRow mark={<ProviderMark driverKind={accounts[0]!.driverKind} size={16} />}
        label={<span className="min-w-0 truncate text-[14px] font-semibold text-ink">{accounts[0]!.displayName}</span>} actions={add || undefined} />
      <AccountGroup label={accounts[0]!.displayName} terminal={terminal}>
        {ordered(accounts, drag.orders[base], (account) => account.instanceId).map((account) => {
          const drain = account.drain;
          const main = accounts.length > 1 && (account.accountMain ?? account.instanceId === base);
          const hasDestination = accounts.some((other) => other !== account && accountReady(other));
          return (
            <ConnectionAccount key={account.instanceId} reorder={accounts.length > 1} account={account} label={account.snapshot.account || (account.displayName === accounts[0]!.displayName ? t("connections.connected") : account.displayName)} busy={busy} disabled={Boolean(main && !hasDestination && !drain)}
              named={board?.engines.flatMap((engine) => engine.accounts).find((row) => row.id === account.instanceId)} revision={board?.revision ?? -1}
              reload={reload} signOut={() => void mutate(`/api/accounts/${encodeURIComponent(account.instanceId)}/sign-out`, drain ? { destinationId: drain.destinationId } : {}, main && !drain ? account.instanceId : undefined)} />
          );
        })}
      </AccountGroup>
      {error && <div role="alert" className="mt-2 text-[12px] text-danger">{error.message}</div>}
    </div>
  );
}
