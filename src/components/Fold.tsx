import { useState, type ReactNode } from "react";

import { MOTION_LARGE_MS } from "@/lib/motion";
import { reducedMotion } from "@/lib/phone-swipe";
import { usePresence } from "@/lib/use-presence";

/** Opens and closes its content by its height on the shared fold motion (motion.css); closed, the content unmounts. Open at mount, it shows at once. `className` places the fold in its parent; a margin there stays put while the content folds. With an `id`, an empty hidden box keeps that id while closed, so `aria-controls` always has a target. `soft` is the longer, flat-landing motion for a fold whose rows below travel far. */
export function Fold({ open, id, className, soft, children }: { open: boolean; id?: string; className?: string; soft?: boolean; children: ReactNode }) {
  const { mounted, closing } = usePresence(open, soft ? MOTION_LARGE_MS : undefined);
  const [was, setWas] = useState(open);
  const [opening, setOpening] = useState(false);
  const [landed, setLanded] = useState(false);
  if (open !== was) {
    setWas(open);
    setOpening(open && !reducedMotion());
    setLanded(false);
  }
  if (!mounted) return id ? <div id={id} hidden /> : null;
  return (
    <div
      id={id}
      data-fold={closing ? "closing" : opening ? "opening" : "open"}
      data-fold-soft={soft || undefined}
      data-fold-done={landed || undefined}
      className={className}
      inert={closing || undefined}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget && event.animationName === "fold-open") setOpening(false);
        if (event.target === event.currentTarget && event.animationName === "fold-close") setLanded(true);
      }}
    >
      <div>{children}</div>
    </div>
  );
}
