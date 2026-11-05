import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { isTerminalSkin, useSkin } from "@/lib/skins";
import { useBackLayer } from "@/lib/use-back-layer";
import { usePresence } from "@/lib/use-presence";
import { MENU_CLASS } from "./MessageMenu";
import { Tile } from "./UsageDesk";

const PRESS = "transition-[background-color,transform] duration-100 motion-reduce:transition-none";

/** Passive inspection: finds an account by name and number only, and never changes Main. */
export function AccountPicker({ accounts, viewedId, select }: {
  accounts: { id: string; name: string; number: number; main?: boolean }[];
  viewedId: string;
  select: (id: string) => void;
}) {
  const { t } = useI18n();
  const terminal = isTerminalSkin(useSkin());
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const presence = usePresence(open);
  const viewed = accounts.find((account) => account.id === viewedId) ?? accounts[0]!;
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useBackLayer(open, close);
  useLayoutEffect(() => {
    // Keep the menu inside the desk: on a phone sheet the coarse width runs past its edge.
    const element = menu.current;
    const desk = element?.closest("[data-usage-desk]");
    if (!element || !desk) return;
    element.style.maxWidth = "";
    const room = desk.getBoundingClientRect().right - element.getBoundingClientRect().left;
    if (room > 0 && room < element.offsetWidth) element.style.maxWidth = `${Math.floor(room)}px`;
  }, [presence.mounted]);
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
    // The menu sits inside: a press that scaled it too read as a double flicker before the close.
    <div className={cn("relative -ml-1.5 flex min-w-0 items-center rounded-[3px] [corner-shape:bevel] pl-1.5 hover:bg-raised-hover has-[>button:active]:bg-raised-hover", PRESS,
      !presence.mounted && "has-[>button:active]:scale-[0.97]", open && "bg-raised-hover")}>
      <button ref={trigger} type="button" aria-label={t("accounts.choose", { account: viewed.name })}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}
        className="flex h-7 min-w-0 items-center gap-1.5 pr-1.5 text-[13px] font-medium text-ink [@media(pointer:coarse)]:h-11">
        <span data-account-name="" data-hero-name="" className="min-w-0 truncate">{viewed.name}</span>
        <ChevronDown size={12} aria-hidden="true" className={cn("shrink-0 text-ink-secondary transition-transform motion-reduce:transition-none", open && "rotate-180")} />
      </button>
      {presence.mounted && <div ref={menu} id={id} role="menu" data-closing={presence.closing || undefined}
        className={cn(MENU_CLASS, "absolute -left-1.5 top-full z-10 mt-1 max-h-72 w-[248px] origin-top-left overflow-y-auto rounded-[3px] [corner-shape:bevel] [@media(pointer:coarse)]:w-[304px]")}
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
        {accounts.map((item) => <button key={item.id} type="button" role="menuitemradio" tabIndex={-1}
          aria-label={item.main ? `${item.name} ${t("accounts.main")}` : undefined}
          aria-checked={item.id === viewed.id} onClick={() => {
            select(item.id);
            // A pick that moves focus (Usage focuses the account it brings into view) keeps it there.
            if (menu.current?.contains(document.activeElement)) close(); else setOpen(false);
          }}
          className={cn("flex min-h-9 w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] font-normal text-ink hover:bg-raised/70 [@media(pointer:coarse)]:min-h-11",
            item.id === viewed.id && "bg-raised/50")}>
          <Tile number={item.number} terminal={terminal} />
          <span className="min-w-0 flex-1 truncate">{item.name}</span>
          {item.main && <span className="shrink-0 text-[12px] text-ink-secondary">{t("accounts.main")}</span>}
        </button>)}
      </div>}
    </div>
  );
}
