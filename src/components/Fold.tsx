import { useState, type ReactNode } from "react";

import { reducedMotion } from "@/lib/phone-swipe";
import { usePresence } from "@/lib/use-presence";

/** Opens and closes its content by its height on the shared fold motion (motion.css); closed, the content unmounts. Open at mount, it shows at once. `className` places the fold in its parent; a margin there stays put while the content folds. With an `id`, an empty hidden box keeps that id while closed, so `aria-controls` always has a target. */
export function Fold({ open, id, className, children }: { open: boolean; id?: string; className?: string; children: ReactNode }) {
  const { mounted, closing } = usePresence(open);
  const [was, setWas] = useState(open);
  const [opening, setOpening] = useState(false);
  if (open !== was) {
    setWas(open);
    setOpening(open && !reducedMotion());
  }
  if (!mounted) return id ? <div id={id} hidden /> : null;
  return (
    <div
      id={id}
      data-fold={closing ? "closing" : opening ? "opening" : "open"}
      className={className}
      inert={closing || undefined}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget && event.animationName === "fold-open") setOpening(false);
      }}
    >
      <div>{children}</div>
    </div>
  );
}
