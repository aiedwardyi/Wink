// Concept swap for src/components/AccountConnections.tsx.
// Connections is the one place an email shows: engine icon, number tile, email, Name and Sign Out.
// "Main" leaves this list: the check in Usage is the pick. The icon no longer opens a hover card.
// On a phone, Name and Sign Out fold into one "..." so every email fits on one line.
import { useEffect, useRef, useState } from "react";
import { MoreHorizontal, Plus } from "lucide-react";
import { accountReady, type UsageAccount } from "@/lib/accounts";
import { cn } from "@/lib/cn";
import { isPhone } from "@/lib/phone-swipe";
import { AccountConnections as TodayConnections, CONNECTION_ACTION, ConnectionRow, SignInRow } from "@/components/AccountConnections";
import { ProviderMark } from "@/components/ProviderIcons";
import { ACCOUNTS } from "../fixtures";
import { Tile } from "../Desk";
import { useDeskText } from "../strings";
import "../desk.css";

export { CONNECTION_ACTION, ConnectionRow, SignInRow };

const tileOf = (account: UsageAccount, index: number) => ACCOUNTS.find((a) => a.id === account.instanceId)?.n ?? index + 1;

function email(label: string) {
  const at = label.indexOf("@") + 1;
  return at ? <>{label.slice(0, at)}<wbr />{label.slice(at)}</> : label;
}

const MENU_ITEM = "flex h-11 w-full items-center rounded-lg px-3 text-left text-[13px] text-ink hover:bg-raised-hover";

/** Phone: one "..." holds the two rare actions, so the row keeps its width for the email. */
function RowMenu({ onName }: { onName: () => void }) {
  const x = useDeskText();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button type="button" aria-label={x.t("more")} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}
        className={cn(CONNECTION_ACTION, "-mr-[3px] w-9 justify-end text-ink-secondary hover:no-underline")}>
        <MoreHorizontal size={18} aria-hidden="true" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-10 w-40 rounded-xl border border-hairline/60 bg-raised p-1 shadow-xl">
          <button type="button" role="menuitem" className={MENU_ITEM} onClick={() => { setOpen(false); onName(); }}>{x.t("name")}</button>
          <button type="button" role="menuitem" className={MENU_ITEM}>{x.t("signOut")}</button>
        </div>
      )}
    </div>
  );
}

export function AccountConnections({ accounts, reload }: { accounts: UsageAccount[]; reload: () => Promise<void> }) {
  const x = useDeskText();
  const [naming, setNaming] = useState<string | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const phone = isPhone();
  if (accounts.some((account) => !accountReady(account) && !account.drain)) return <TodayConnections accounts={accounts} reload={reload} />;
  return (
    <div data-engine-row={accounts[0]!.accountOf ?? accounts[0]!.instanceId} className="min-w-0 py-1.5">
      {accounts.map((account, index) => {
        const n = tileOf(account, index);
        const nick = names[account.instanceId];
        return (
          <ConnectionRow key={account.instanceId} mark={<ProviderMark driverKind={account.driverKind} size={16} />}
            label={<>
              <Tile n={n} />
              {naming === account.instanceId ? (
                <form className="flex min-w-0 flex-1 items-center gap-2" onSubmit={(event) => { event.preventDefault(); setNaming(null); }}>
                  <input autoFocus aria-label={x.t("name")} defaultValue={nick ?? ""} placeholder={x.t("name")}
                    onChange={(event) => setNames({ ...names, [account.instanceId]: event.target.value })}
                    className="min-w-0 flex-1 rounded-md border border-hairline bg-inset px-2 py-1 text-[12px] text-ink outline-none focus:border-accent-border" />
                </form>
              ) : (
                <span className="min-w-0 break-words text-ink">
                  {nick && <span className="mr-1.5 font-medium">{nick}</span>}
                  <span className={nick ? "text-ink-secondary" : undefined}>{email(account.snapshot.account || account.displayName)}</span>
                </span>
              )}
            </>}
            actions={phone ? <RowMenu onName={() => setNaming(account.instanceId)} /> : <>
              <button type="button" onClick={() => setNaming(naming === account.instanceId ? null : account.instanceId)} className={CONNECTION_ACTION}>{x.t("name")}</button>
              <button type="button" className={CONNECTION_ACTION}>{x.t("signOut")}</button>
            </>} />
        );
      })}
      {/* Add gets its own row, so no account row carries three actions (no email wraps at 390). */}
      <ConnectionRow mark={<Plus size={14} aria-hidden="true" className="text-ink-secondary" />}
        label={<button type="button" className={CONNECTION_ACTION}>{x.t("addAccount")}</button>} />
    </div>
  );
}
