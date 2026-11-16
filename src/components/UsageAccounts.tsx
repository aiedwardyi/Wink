import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Pencil } from "lucide-react";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import type { UsageBoardAccount } from "@/lib/usage-board";
import { invalidateUsageBoard } from "@/lib/usage-board-client";
import { MENU_ITEM_HOVER } from "@/lib/menu-style";
import { useBackLayer } from "@/lib/use-back-layer";
import { scrollsAnchor } from "@/lib/use-hold-menu";
import { usePresence } from "@/lib/use-presence";
import { MENU_CLASS } from "./MessageMenu";
import { AccountNameEditor, type SavedAccountName } from "./AccountNameEditor";

const PRESS = "transition-transform motion-reduce:transition-none";

export function EditableAccountName({ account, revision, editable }: { account: UsageBoardAccount; revision: number; editable: boolean }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState<(SavedAccountName & { revision: number }) | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const version = useRef(revision);
  version.current = revision;
  const name = saved && saved.revision >= revision ? saved : account;
  useLayoutEffect(() => {
    if (!editing && restoreFocus.current) { restoreFocus.current = false; button.current?.focus(); }
  }, [editing]);
  const close = () => { restoreFocus.current = true; setEditing(false); };
  if (editing) return <AccountNameEditor id={account.id} nickname={name.nickname} inline onClose={close}
    onSaved={(next) => { setSaved({ ...next, revision: version.current }); invalidateUsageBoard(); }} />;
  return editable ? <button ref={button} type="button" data-edit-name="" aria-label={t("accounts.name.edit")}
    onClick={() => setEditing(true)} className="usage-name-button min-w-0 text-left">
    <span data-account-name="" className="min-w-0 break-keep [overflow-wrap:anywhere]">{name.name}</span><Pencil size={10} aria-hidden="true" />
  </button> : <span data-account-name="" className="min-w-0 break-keep [overflow-wrap:anywhere]">{name.name}</span>;
}

/** Shared radio menu for account inspection and settings fields. */
export function AccountPicker({ accounts, viewedId, select, label, field = false, className, triggerClassName }: {
  accounts: { id: string; name: string; main?: boolean; icon?: ReactNode }[];
  viewedId: string;
  select: (id: string) => void;
  label?: string;
  field?: boolean;
  className?: string;
  triggerClassName?: string;
}) {
  const { t } = useI18n();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState({ top: 0, left: 0, width: 248, maxHeight: 288 });
  const [height, setHeight] = useState(0);
  const presence = usePresence(open);
  const viewed = accounts.find((account) => account.id === viewedId) ?? accounts[0]!;
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: field }); };
  useBackLayer(open, close);
  useLayoutEffect(() => {
    if (field) {
      if (!open || !trigger.current || !menu.current) return;
      const rect = trigger.current.getBoundingClientRect();
      const width = Math.min(Math.max(rect.width, window.matchMedia?.("(pointer: coarse)").matches ? 304 : 248), window.innerWidth - 16);
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const up = below < Math.min(menu.current.scrollHeight, 200) && above > below;
      const maxHeight = Math.max(0, Math.min(288, up ? above : below));
      setPlacement({ top: up ? rect.top - Math.min(menu.current.scrollHeight, maxHeight) - 4 : rect.bottom + 4,
        left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)), width, maxHeight });
      return;
    }
    // Keep the menu inside the desk: on a phone sheet the coarse width runs past its edge.
    const element = menu.current;
    const desk = element?.closest("[data-usage-desk]");
    if (!element || !desk) return;
    element.style.maxWidth = "";
    const room = desk.getBoundingClientRect().right - element.getBoundingClientRect().left;
    if (room > 0 && room < element.offsetWidth) element.style.maxWidth = `${Math.floor(room)}px`;
  }, [presence.mounted, open, field, height]);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) setOpen(false);
    };
    const scroll = (event: Event) => {
      if (scrollsAnchor(event, trigger.current)) close();
    };
    // A phone keyboard changes only the height: place again there, close on a real size change.
    const width = window.innerWidth;
    const resize = () => {
      if (window.innerWidth === width) setHeight(window.innerHeight);
      else close();
    };
    const dismiss = () => setOpen(false);
    window.addEventListener("pointerdown", outside, true);
    if (field) {
      window.addEventListener("scroll", scroll, true);
      window.addEventListener("resize", resize);
      window.addEventListener("blur", dismiss);
    }
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", resize);
      window.removeEventListener("blur", dismiss);
    };
  }, [open, field]);
  const popup = presence.mounted && <div ref={menu} id={id} role="menu" aria-label={label} data-closing={presence.closing || undefined} inert={field && presence.closing}
    style={field ? placement : undefined}
    className={cn(MENU_CLASS, field ? "z-[60] origin-top-right overflow-y-auto" : "absolute -left-1.5 top-full z-10 mt-1 max-h-72 w-[248px] origin-top-left overflow-y-auto [@media(pointer:coarse)]:w-[304px]")}
    onBlur={(event) => { if (event.relatedTarget && event.relatedTarget !== trigger.current && !event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    onKeyDown={(event) => {
      if (event.key === "Tab") { if (field) close(); else setOpen(false); }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      if (field && event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        if (document.activeElement instanceof HTMLButtonElement && menu.current?.contains(document.activeElement)) document.activeElement.click();
      }
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
      aria-checked={item.id === viewed?.id} onClick={() => {
        if (field && !open) return;
        if (!field || item.id !== viewed?.id) select(item.id);
        // A pick that moves focus (Usage focuses the account it brings into view) keeps it there.
        if (menu.current?.contains(document.activeElement)) close(); else setOpen(false);
      }}
      className={cn("flex min-h-9 w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] font-normal text-ink [@media(pointer:coarse)]:min-h-11", MENU_ITEM_HOVER,
        field && "gap-3 px-3.5 py-2 text-[14px]", item.id === viewed?.id && "bg-raised/50")}>
      {item.icon && <span aria-hidden="true" className={cn("shrink-0 text-ink-secondary", field && "flex size-5 items-center justify-center")}>{item.icon}</span>}
      <span className="min-w-0 flex-1 truncate">{item.name}</span>
      {item.main && <span className="shrink-0 text-[12px] text-ink-secondary">{t("accounts.main")}</span>}
      {field && <span className="size-4 shrink-0">{item.id === viewed?.id && <Check size={16} aria-hidden="true" />}</span>}
    </button>)}
  </div>;
  return (
    // The menu sits inside: a press that scaled it too read as a double flicker before the close.
    <div className={cn("relative flex min-w-0 items-center", !field && "-ml-1.5 rounded-[3px] [corner-shape:bevel] pl-1.5 hover:bg-raised-hover has-[>button:active]:bg-raised-hover", PRESS,
      !presence.mounted && "has-[>button:active]:scale-[0.97]", !field && open && "bg-raised-hover", className)}>
      <button ref={trigger} type="button" disabled={!viewed} aria-label={label ?? t("accounts.choose", { account: viewed?.name ?? "" })}
        aria-describedby={field ? `${id}-value` : undefined}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (field && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); setOpen(true); }
        }}
        className={cn("flex h-7 min-w-0 items-center gap-1.5 pr-1.5 text-[13px] font-medium text-ink [@media(pointer:coarse)]:h-11",
          field && "h-auto w-full justify-between rounded-lg bg-control px-2 py-1.5 font-normal", triggerClassName)}>
        {viewed?.icon && <span aria-hidden="true" className="shrink-0">{viewed.icon}</span>}
        <span id={field ? `${id}-value` : undefined} data-account-name={field ? undefined : ""} data-hero-name={field ? undefined : ""} className="min-w-0 truncate">{viewed?.name}</span>
        <ChevronDown size={12} aria-hidden="true" className={cn("shrink-0 text-ink-secondary transition-transform motion-reduce:transition-none", open && "rotate-180")} />
      </button>
      {field ? popup && createPortal(popup, document.body) : popup}
    </div>
  );
}
