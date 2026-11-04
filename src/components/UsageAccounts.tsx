import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { api } from "@/state/store";
import { accountReady, type UsageAccount } from "@/lib/accounts";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { reducedMotion } from "@/lib/phone-swipe";
import { useIsPhone } from "@/lib/use-phone-swipe";
import { useBackLayer } from "@/lib/use-back-layer";
import { usePresence } from "@/lib/use-presence";
import { EngineMark } from "./EngineMark";
import { MENU_CLASS } from "./MessageMenu";
import { ROW_BUTTON } from "./SettingsPrimitives";

const PRESS = "transition-[background-color,transform] duration-100 motion-reduce:transition-none";

// Moves only what sits under the head, so the arrows stay put under the finger.
// The old page fades in place and quickly: sliding both doubles the shared 5h/7d labels.
function slide(page: Element | null | undefined, dir: number, out = false) {
  const head = page?.querySelector("[data-account-head]");
  for (const part of head?.parentElement?.children ?? []) {
    if (part === head) continue;
    part.animate(out
      ? [{ visibility: "visible" }, { visibility: "visible", opacity: 0 }]
      : [{ opacity: 0, transform: `translateX(${dir * 12}px)` }, {}],
    { duration: out ? 80 : 160, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
  }
}

function AccountPicker({ account, accounts, mainId, label, mark, select }: {
  account: UsageAccount;
  accounts: UsageAccount[];
  mainId: string;
  label: (account: UsageAccount) => string;
  mark: ReactNode;
  select: (id: string) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const presence = usePresence(open);
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
    <div className={cn("-ml-1.5 flex min-w-0 items-center gap-2 rounded-[3px] [corner-shape:bevel] pl-1.5 hover:bg-raised-hover has-[>button:active]:scale-[0.97] has-[>button:active]:bg-raised-hover", PRESS, open && "bg-raised-hover")}>
      {mark}
      <button ref={trigger} type="button" title={label(account)} aria-label={t("accounts.choose", { account: label(account) })}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}
        className="flex h-7 min-w-0 items-center gap-1 pr-1.5 max-md:h-11 [@media(pointer:coarse)]:ml-1.5 [@media(pointer:coarse)]:h-11">
        <span className="min-w-0 truncate">{label(account)}</span>
        <ChevronDown size={12} aria-hidden="true" className={cn("shrink-0 text-ink-secondary transition-transform duration-150 motion-reduce:transition-none", open && "rotate-180")} />
      </button>
      {presence.mounted && <div ref={menu} id={id} role="menu" data-closing={presence.closing || undefined}
        className={cn(MENU_CLASS, "absolute -left-1.5 top-full mt-1 max-h-72 w-[248px] max-w-[calc(100%+0.375rem)] origin-top-left overflow-y-auto rounded-[3px] [corner-shape:bevel] [@media(pointer:coarse)]:w-[304px]")}
        onBlur={(event) => { if (event.relatedTarget && event.relatedTarget !== trigger.current && !event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
        onKeyDown={(event) => {
          if (event.key === "Tab") setOpen(false);
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
        {accounts.map((item) => <button key={item.instanceId} type="button" role="menuitemradio" tabIndex={-1} title={label(item)}
          aria-label={`${label(item)}${item.instanceId === mainId ? ` ${t("accounts.main")}` : ""}`}
          aria-checked={item.instanceId === account.instanceId} onClick={() => { select(item.instanceId); close(); }}
          className="flex min-h-9 w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] font-normal text-ink hover:bg-raised/70 max-md:min-h-11 [@media(pointer:coarse)]:min-h-11">
          <Check size={16} aria-hidden="true" className={cn("shrink-0", item.instanceId !== account.instanceId && "invisible")} />
          <span className="min-w-0 truncate">{label(item)}</span>
          {item.instanceId === mainId && <span className="ml-auto shrink-0 text-[12px] text-ink-secondary">{t("accounts.main")}</span>}
        </button>)}
      </div>}
    </div>
  );
}

export function UsageAccounts({ accounts, reload, renderRow }: {
  accounts: UsageAccount[];
  reload: () => Promise<void>;
  renderRow: (account: UsageAccount, heading?: ReactNode) => ReactNode;
}) {
  const { t } = useI18n();
  const phone = useIsPhone();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const columns = useRef<HTMLDivElement>(null);
  const mainColumn = useRef<HTMLDivElement>(null);
  const live = useRef<HTMLDivElement>(null);
  const focusPicker = useRef(false);
  const refocus = useRef<string | null>(null);
  const turn = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const main = accounts.find((account) => account.accountMain)
    ?? accounts.find((account) => account.instanceId === account.accountOf) ?? accounts[0]!;
  const others = accounts.filter((account) => account !== main);
  const pages = phone ? [main, ...others] : others;
  const index = Math.max(0, pages.findIndex((account) => account.instanceId === selectedId));
  const currentId = pages[index]?.instanceId ?? null;
  const shownId = useRef(currentId);
  useEffect(() => {
    if (selectedId !== currentId) setSelectedId(currentId);
  }, [currentId, selectedId]);
  // The live page keeps its DOM across accounts, so the bars glide to the new values like a refresh.
  useLayoutEffect(() => {
    const dir = turn.current;
    const from = shownId.current;
    turn.current = 0;
    shownId.current = currentId;
    if (focusPicker.current) {
      focusPicker.current = false;
      live.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.focus();
    }
    if (!dir || from === currentId || reducedMotion()) return;
    slide(live.current, dir);
    slide([...columns.current?.querySelectorAll<HTMLElement>("[data-account-page]") ?? []].find((page) => page.dataset.accountPage === from), dir, true);
  }, [currentId]);
  // A new Main trades columns with the old one: each slides in from the side it left.
  const shownMain = useRef(main.instanceId);
  useLayoutEffect(() => {
    if (shownMain.current === main.instanceId) return;
    shownMain.current = main.instanceId;
    if (refocus.current === main.instanceId) {
      const head = live.current;
      (head?.querySelector<HTMLElement>("[data-set-main]") ?? head?.querySelector<HTMLElement>('[aria-haspopup="menu"]'))?.focus();
    }
    refocus.current = null;
    if (phone || reducedMotion()) return;
    for (const [column, dir] of [[mainColumn.current, 1], [live.current, -1]] as const) {
      column?.animate([{ opacity: 0, transform: `translateX(${dir * 24}px)` }, {}], { duration: 220, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
    }
  }, [main.instanceId, phone]);
  if (accounts.length === 1) return renderRow(accounts[0]!);
  const label = (account: UsageAccount) => account.snapshot.account || t("accounts.numbered", { number: accounts.indexOf(account) + 1 });
  const go = (id: string, focus = false) => {
    turn.current = Math.sign(pages.findIndex((account) => account.instanceId === id) - index);
    focusPicker.current = focus && id !== currentId;
    setSelectedId(id);
  };
  const setAsMain = async (account: UsageAccount) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/accounts/${encodeURIComponent(account.instanceId)}/default`, { method: "POST", body: "{}" });
      refocus.current = account.instanceId;
      await reload();
      if (!phone) setSelectedId(main.instanceId);
    } catch (error) { setError(error instanceof Error && error.message || t("engines.didntFinish")); }
    finally { setBusy(false); }
  };
  const arrow = "flex size-7 items-center justify-center rounded-[3px] [corner-shape:bevel] text-ink enabled:hover:bg-raised-hover enabled:active:scale-90 enabled:active:bg-raised-hover disabled:opacity-25 max-md:size-11 [@media(pointer:coarse)]:size-11";
  const arrows = pages.length > 1 && (
    <span className="ml-auto flex shrink-0 items-center">
      <button type="button" aria-label={t("accounts.previous")} disabled={index === 0}
        onClick={() => go(pages[index - 1]!.instanceId)} className={cn(arrow, PRESS)}>
        <ChevronLeft size={16} aria-hidden="true" />
      </button>
      <button type="button" aria-label={t("accounts.next")} disabled={index === pages.length - 1}
        onClick={() => go(pages[index + 1]!.instanceId)} className={cn(arrow, PRESS)}>
        <ChevronRight size={16} aria-hidden="true" />
      </button>
    </span>
  );
  const heading = (account: UsageAccount, other = false) => {
    const mark = <EngineMark instance={account} size={16} tapToShow />;
    const picker = (phone || other) && pages.length > 1;
    const line = "relative flex min-h-7 items-center gap-2 [@media(pointer:coarse)]:min-h-11";
    // The email gets the whole first line, so Set as Main and the arrows never squeeze it.
    return (
      <div data-account-head="" className="text-[13px] font-medium text-ink">
        <div className={line}>
          {picker
            ? <AccountPicker account={account} accounts={pages} mainId={main.instanceId} label={label} mark={mark} select={(id) => go(id, true)} />
            : <>{mark}<span className="min-w-0 truncate" title={label(account)}>{label(account)}</span></>}
        </div>
        <div className={cn(line, "pl-6", picker && "[@media(pointer:coarse)]:pl-7.5")}>
          {other ? accountReady(account) && <button type="button" data-set-main="" disabled={busy} onClick={() => void setAsMain(account)}
            className={ROW_BUTTON}>{t("accounts.setAsMain")}</button>
            : <span className="text-[12px] font-normal text-ink-secondary">{t("accounts.main")}</span>}
          {(phone || other) && arrows}
        </div>
      </div>
    );
  };
  const column = (account: UsageAccount, other = false) => (
    <div className="min-w-0">
      {accountReady(account) ? renderRow(account, heading(account, other)) : <>
        {heading(account, other)}
        <div className="mt-2 text-[12px] text-ink-secondary">{t("accounts.signedOut")}</div>
      </>}
    </div>
  );
  const current = pages[index]!;
  return (
    <div ref={columns} className={phone ? "grid gap-y-4" : "grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2"}>
      {!phone && <div key={main.instanceId} ref={mainColumn} data-account-column="main">{column(main)}</div>}
      <div className="grid min-w-0" data-account-column={phone ? "pages" : "other"}>
        {pages.map((account) => account !== current && <div key={account.instanceId} data-account-page={account.instanceId}
          className="col-start-1 row-start-1 min-w-0" style={{ visibility: "hidden" }} inert aria-hidden>
          {column(account, account !== main)}
        </div>)}
        <div key={`live-${main.instanceId}`} ref={live} className="col-start-1 row-start-1 min-w-0">{column(current, current !== main)}</div>
      </div>
      {error && <div role="alert" className="text-[12px] text-danger sm:col-span-2">{error}</div>}
    </div>
  );
}
