import { useLayoutEffect, useRef, useState, type HTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";

export const FOLD_FADE = "[mask-image:linear-gradient(to_bottom,black_60%,transparent)]";

export function FoldToggle({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  return (
    <button onClick={onToggle} className="mt-1 text-[12.5px] text-ink-secondary hover:text-ink">
      {t(expanded ? "chat.showLess" : "chat.showFullMessage")}
    </button>
  );
}

/** Clips its children at 3 lines; the fade and toggle show only when something is cut. */
export function FoldClip({ children, className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    const measure = () => setCut(el.scrollHeight > el.clientHeight + 1);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [expanded, children]);
  return (
    <>
      <div ref={ref} data-fold="" className={cn(!expanded && "max-h-[3lh] overflow-hidden", !expanded && cut && FOLD_FADE, className)} {...rest}>
        {children}
      </div>
      {(cut || expanded) && <FoldToggle expanded={expanded} onToggle={() => setExpanded(!expanded)} />}
    </>
  );
}
