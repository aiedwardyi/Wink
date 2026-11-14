import { Fragment, useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { afterFold } from "@/lib/fold-press";
import type { Translate } from "@/lib/i18n";
import type { UsageBoardAccount } from "@/lib/usage-board";
import { Fold } from "./Fold";

function pickRows(accounts: UsageBoardAccount[], checked: string | null) {
  const picked = accounts.slice(0, 3);
  const main = accounts.find((each) => each.id === checked);
  if (main && !picked.includes(main)) picked[2] = main;
  return picked.map((each) => each.id);
}

export function useCappedAccounts({ accounts, checked, t, row, loadOpen, saveOpen }: {
  accounts: UsageBoardAccount[]; checked: string | null; t: Translate; row: (account: UsageBoardAccount) => ReactNode;
  loadOpen: () => boolean; saveOpen: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(loadOpen);
  const [picked, setPicked] = useState(() => pickRows(accounts, checked));
  if (!open && checked && accounts.some((account) => account.id === checked) && !picked.includes(checked)) setPicked(pickRows(accounts, checked));
  const id = useId();
  if (accounts.length <= 3) return accounts.map(row);
  const groups: { kept: boolean; accounts: UsageBoardAccount[] }[] = [];
  for (const account of accounts) {
    const kept = picked.includes(account.id);
    const last = groups.at(-1);
    if (last?.kept === kept) last.accounts.push(account);
    else groups.push({ kept, accounts: [account] });
  }
  const hidden = accounts.filter((each) => !picked.includes(each.id)).length;
  const moving = groups.findIndex((each) => !each.kept);
  const toggle = () => afterFold(`${id}-${moving}`, () => {
    if (open) setPicked(pickRows(accounts, checked));
    saveOpen(!open);
    setOpen(!open);
  });
  return (
    <div>
      <div id={id} className="[&_[data-account-row]]:border-t [&>[data-account-row]:first-child]:border-t-0">
        {groups.map((group, index) => group.kept
          ? <Fragment key={group.accounts[0]!.id}>{group.accounts.map(row)}</Fragment>
          : <Fold key={group.accounts[0]!.id} id={`${id}-${index}`} open={open}>{group.accounts.map(row)}</Fold>)}
      </div>
      <div className="usage-cap border-t border-hairline/70">
        <button type="button" data-accounts-cap="" aria-expanded={open} aria-controls={id} onClick={toggle}
          className="group flex min-h-5 items-center gap-2 text-[14px] font-semibold text-ink-secondary hover:text-ink [@media(pointer:coarse)]:min-h-11">
          <ChevronDown size={14} strokeWidth={2} aria-hidden="true"
            className={cn("shrink-0 transition-transform motion-reduce:transition-none", !open && "-rotate-90")} />
          {t(open ? "usage.desk.showLess" : "usage.desk.showMore", { count: hidden })}
        </button>
      </div>
    </div>
  );
}
