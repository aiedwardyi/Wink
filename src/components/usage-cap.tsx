import { Fragment, useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { afterFold } from "@/lib/fold-press";
import type { Translate } from "@/lib/i18n";
import type { UsageBoardAccount } from "@/lib/usage-board";
import { Fold } from "./Fold";

// Slots plus the ids they held: a collapsed reorder permutes those ids within the slots, while an order that brings other rows into them picks again.
function pickRows(accounts: UsageBoardAccount[], checked: string | null) {
  const main = accounts.findIndex((each) => each.id === checked);
  const slots = [0, 1, main > 2 ? main : 2];
  return { slots, ids: slots.map((slot) => accounts[slot]?.id) };
}

export function useCappedAccounts({ accounts, checked, pending, t, row, loadOpen, saveOpen }: {
  accounts: UsageBoardAccount[]; checked: string | null; pending: string | undefined; t: Translate; row: (account: UsageBoardAccount) => ReactNode;
  loadOpen: () => boolean; saveOpen: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(loadOpen);
  const [picked, setPicked] = useState(() => pickRows(accounts, checked));
  // Only the save the board accepted keeps the old Main shown when it lands; a Main the board moves on its own picks again.
  const [main, setMain] = useState({ checked, pending });
  if (main.checked !== checked || main.pending !== pending) setMain({ checked, pending });
  const moved = main.checked !== checked && checked !== main.pending;
  const at = accounts.findIndex((account) => account.id === checked);
  const reordered = picked.slots.some((slot) => !picked.ids.includes(accounts[slot]?.id));
  if (!open && (moved || reordered || (at >= 0 && !picked.slots.includes(at)))) setPicked(pickRows(accounts, checked));
  const id = useId();
  if (accounts.length <= 3) return accounts.map(row);
  const groups: { kept: boolean; accounts: UsageBoardAccount[] }[] = [];
  for (const [index, account] of accounts.entries()) {
    const kept = picked.slots.includes(index);
    const last = groups.at(-1);
    if (last?.kept === kept) last.accounts.push(account);
    else groups.push({ kept, accounts: [account] });
  }
  const hidden = accounts.filter((_, index) => !picked.slots.includes(index)).length;
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
