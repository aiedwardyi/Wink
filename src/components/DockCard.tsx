import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/cn";
import { clearSheetMotion, useIsPhone, useSheetSwipe } from "@/lib/use-phone-swipe";
import { usePresence } from "@/lib/use-presence";

/** A card docked above the message box: on a phone it opens and closes on the call settings sheet's motion, and with onDismiss a swipe down does what its x does, the card riding the finger over the message box. */
export function DockCard({ open, onDismiss, id, className, children }: { open: boolean; onDismiss?: () => void; id?: string; className?: string; children: ReactNode }) {
  const phone = useIsPhone();
  const card = useRef<HTMLDivElement>(null);
  const { mounted, closing } = usePresence(open);
  // open at mount (a chat switch, a swipe peek) shows at once; only a later open pops in
  const [still, setStill] = useState(open);
  if (!open && still) setStill(false);
  const kept = useRef(children);
  if (open) kept.current = children;
  useSheetSwipe(card, open && phone && Boolean(onDismiss), () => onDismiss?.());
  // a new id is the next card in the same place: at rest, not where a swipe let go of the last one
  useLayoutEffect(() => {
    if (!open) return;
    clearSheetMotion(card.current);
  }, [id, open]);
  if (!mounted || (closing && !phone)) return null;
  return (
    <div ref={card} data-dock-card="" data-closing={closing || undefined} inert={closing || undefined} className={cn(phone && !still && "animate-pop-in", className)}>
      {open ? children : kept.current}
    </div>
  );
}
