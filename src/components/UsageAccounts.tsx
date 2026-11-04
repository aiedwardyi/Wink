import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { api } from "@/state/store";
import { accountReady, type UsageAccount } from "@/lib/accounts";
import { useI18n } from "@/lib/i18n";
import { useIsPhone } from "@/lib/use-phone-swipe";
import { useBackLayer } from "@/lib/use-back-layer";
import { EngineMark } from "./EngineMark";
import { ProviderMark } from "./ProviderIcons";

function AccountPicker({ account, accounts, mainId, label, select }: {
  account: UsageAccount;
  accounts: UsageAccount[];
  mainId: string;
  label: (account: UsageAccount) => string;
  select: (id: string) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useBackLayer(open, close);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) setOpen(false);
    };
    window.addEventListener("pointerdown", outside, true);
    return () => window.removeEventListener("pointerdown", outside, true);
  }, [open]);
  return (
    <div className="min-w-0 flex-1">
      <button ref={trigger} type="button" title={label(account)} aria-label={t("accounts.choose", { account: label(account) })}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}
        className="flex min-h-7 w-full items-center gap-2 text-left hover:bg-raised-hover focus-visible:outline-2 focus-visible:outline-accent max-md:min-h-11 [@media(pointer:coarse)]:min-h-11">
        <ProviderMark driverKind={account.driverKind} size={16} className="shrink-0" />
        <span className="min-w-0 truncate">{label(account)}</span>
        <ChevronDown size={12} aria-hidden="true" className="ml-auto shrink-0" />
      </button>
      {open && <div ref={menu} id={id} role="menu" aria-label={t("accounts.choose", { account: label(account) })}
        className="absolute inset-x-0 top-full z-40 max-h-72 overflow-y-auto rounded-[3px] [corner-shape:bevel] border border-hairline/40 bg-card py-1 shadow-lg"
        onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
              : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
            items[next]?.focus();
          }
        }}>
        {accounts.map((item) => <button key={item.instanceId} type="button" role="menuitemradio" tabIndex={-1}
          aria-checked={item.instanceId === account.instanceId} onClick={() => { select(item.instanceId); close(); }}
          className="flex min-h-8 w-full items-center gap-2 px-2 py-1 text-left text-[13px] font-normal text-ink hover:bg-raised-hover focus:bg-raised-hover focus:outline-none max-md:min-h-11 [@media(pointer:coarse)]:min-h-11">
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">{label(item)}</span>
          {item.instanceId === mainId && <span className="ml-auto shrink-0 text-[12px] text-ink-secondary">{t("accounts.main")}</span>}
        </button>)}
      </div>}
    </div>
  );
}

export function UsageAccounts({ accounts, reload, renderRow }: {
  accounts: UsageAccount[];
  reload: () => Promise<void>;
  renderRow: (account: UsageAccount, heading?: ReactNode, dim?: boolean) => ReactNode;
}) {
  const { t } = useI18n();
  const phone = useIsPhone();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const columns = useRef<HTMLDivElement>(null);
  const focusSelection = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const main = accounts.find((account) => account.accountMain)
    ?? accounts.find((account) => account.instanceId === account.accountOf) ?? accounts[0]!;
  const others = accounts.filter((account) => account !== main);
  const pages = phone ? [main, ...others] : others;
  const index = Math.max(0, pages.findIndex((account) => account.instanceId === selectedId));
  const currentId = pages[index]?.instanceId ?? null;
  useEffect(() => {
    if (selectedId !== currentId) setSelectedId(currentId);
    if (focusSelection.current) {
      columns.current?.querySelector<HTMLButtonElement>('[data-account-column] > div:not([inert]) [aria-haspopup="menu"]')?.focus();
      focusSelection.current = false;
    }
  }, [currentId, selectedId]);
  if (accounts.length === 1) return renderRow(accounts[0]!);
  const label = (account: UsageAccount) => account.snapshot.account || t("accounts.numbered", { number: accounts.indexOf(account) + 1 });
  const setAsMain = async (account: UsageAccount) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/accounts/${encodeURIComponent(account.instanceId)}/default`, { method: "POST", body: "{}" });
      await reload();
      setSelectedId(null);
    } catch (error) { setError(error instanceof Error && error.message || t("engines.didntFinish")); }
    finally { setBusy(false); }
  };
  const arrows = pages.length > 1 && (
    <span className="flex shrink-0 items-center">
      <button type="button" aria-label={t("accounts.previous")} disabled={index === 0}
        onClick={() => setSelectedId(pages[index - 1]!.instanceId)} className="flex size-7 items-center justify-center text-ink-secondary hover:text-ink disabled:opacity-30 [@media(pointer:coarse)]:size-11">
        <ChevronLeft size={15} aria-hidden="true" />
      </button>
      <button type="button" aria-label={t("accounts.next")} disabled={index === pages.length - 1}
        onClick={() => setSelectedId(pages[index + 1]!.instanceId)} className="flex size-7 items-center justify-center text-ink-secondary hover:text-ink disabled:opacity-30 [@media(pointer:coarse)]:size-11">
        <ChevronRight size={15} aria-hidden="true" />
      </button>
    </span>
  );
  const heading = (account: UsageAccount, other = false) => (
    <div className="relative flex min-h-7 items-center gap-2 text-[13px] font-medium text-ink [@media(pointer:coarse)]:min-h-11">
      {(phone || other) && pages.length > 1 ? <AccountPicker account={account} accounts={pages} mainId={main.instanceId} label={label}
        select={(id) => { focusSelection.current = id !== currentId; setSelectedId(id); }} /> : <>
        <EngineMark instance={account} size={16} tapToShow />
        {!other && <span title={account.snapshot.account} className="min-w-0 truncate">{account.snapshot.account || account.displayName}</span>}
      </>}
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {other ? accountReady(account) && <button type="button" disabled={busy} onClick={() => void setAsMain(account)}
          className="relative flex h-7 items-center rounded-[3px] [corner-shape:bevel] border border-hairline/40 px-2 text-[12px] font-normal text-ink-secondary hover:bg-raised-hover focus-visible:bg-raised-hover focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50 [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-y-2 [@media(pointer:coarse)]:after:inset-x-0">{t("accounts.setAsMain")}</button>
          : <span className="text-[12px] font-normal text-ink-secondary">{t("accounts.main")}</span>}
        <span className="flex w-14 shrink-0 [@media(pointer:coarse)]:w-22">{(phone || other) && arrows}</span>
      </span>
    </div>
  );
  const column = (account: UsageAccount, other = false) => (
    <div className="min-w-0">
      {accountReady(account) ? renderRow(account, heading(account, other), other) : <>
        {heading(account, other)}
        <div className="mt-2 text-[12px] text-ink-secondary">{t("accounts.signedOut")}</div>
      </>}
    </div>
  );
  return (
    <div ref={columns} className={phone ? "grid gap-y-4" : "grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2"}>
      {!phone && <div data-account-column="main">{column(main)}</div>}
      <div className="grid min-w-0" data-account-column={phone ? "pages" : "other"}>
        {pages.map((account, i) => <div key={account.instanceId} className="col-start-1 row-start-1 min-w-0"
          style={i === index ? undefined : { visibility: "hidden" }} inert={i !== index} aria-hidden={i !== index || undefined}>
          {column(account, account !== main)}
        </div>)}
      </div>
      {error && <div role="alert" className="text-[12px] text-danger sm:col-span-2">{error}</div>}
    </div>
  );
}
