import { Fragment, useId, useState, type MouseEvent, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { afterFold } from "@/lib/fold-press";
import type { Translate } from "@/lib/i18n";
import type { UsageBoardAccount } from "@/lib/usage-board";
import { Fold } from "./Fold";

// Slots, not ids: a collapsed reorder permutes rows within the shown slots, while an order from another view shows through.
function pickRows(accounts: UsageBoardAccount[], checked: string | null) {
  const main = accounts.findIndex((each) => each.id === checked);
  return [0, 1, main > 2 ? main : 2];
}

export function useCappedAccounts({ accounts, checked, t, row, loadOpen, saveOpen }: {
  accounts: UsageBoardAccount[]; checked: string | null; t: Translate; row: (account: UsageBoardAccount) => ReactNode;
  loadOpen: () => boolean; saveOpen: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(loadOpen);
  const [picked, setPicked] = useState(() => pickRows(accounts, checked));
  // Only a Use pressed here keeps the old Main shown; a Main the board moves on its own picks again.
  const [main, setMain] = useState<{ checked: string | null; used?: string }>({ checked });
  const moved = main.checked !== checked;
  if (moved) setMain({ checked });
  const at = accounts.findIndex((account) => account.id === checked);
  if (!open && ((moved && checked !== main.used) || (at >= 0 && !picked.includes(at)))) setPicked(pickRows(accounts, checked));
  const id = useId();
  if (accounts.length <= 3) return accounts.map(row);
  const use = (event: MouseEvent) => {
    const used = event.target instanceof Element && event.target.closest("[data-use]")?.closest<HTMLElement>("[data-account-row]")?.dataset.accountRow;
    if (used) setMain({ checked, used });
  };
  const groups: { kept: boolean; accounts: UsageBoardAccount[] }[] = [];
  for (const [index, account] of accounts.entries()) {
    const kept = picked.includes(index);
    const last = groups.at(-1);
    if (last?.kept === kept) last.accounts.push(account);
    else groups.push({ kept, accounts: [account] });
  }
  const hidden = accounts.filter((_, index) => !picked.includes(index)).length;
  const moving = groups.findIndex((each) => !each.kept);
  const toggle = () => afterFold(`${id}-${moving}`, () => {
    if (open) setPicked(pickRows(accounts, checked));
    saveOpen(!open);
    setOpen(!open);
  });
  return (
    <div>
      <div id={id} onClickCapture={use} className="[&_[data-account-row]]:border-t [&>[data-account-row]:first-child]:border-t-0">
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
