import { useEffect, useLayoutEffect, useRef, type ReactNode, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

// a hairline edge, so a group still reads on skins whose card color matches the panel
export const DETAILS_BOX = "overflow-clip rounded-xl border border-hairline/60 bg-card";
export const DETAILS_ROW = "border-t border-hairline/40 px-4 py-3 first:border-t-0";
export const DETAILS_INPUT =
  "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] leading-relaxed text-ink placeholder:text-ink-secondary focus:outline-none focus:border-hairline";

export function DetailsSwitch({ on, label, disabled, className, onToggle }: {
  on: boolean;
  label: string;
  disabled?: boolean;
  className?: string;
  onToggle: () => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={cn("relative h-6 w-11 shrink-0 rounded-full transition-colors", on ? "bg-accent" : "bg-control", className)}
    >
      <span className={cn("absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white transition-all", on ? "left-[21px]" : "left-[3px]")} />
    </button>
  );
}

export function DetailsLabel({ label, hint }: { label: string; hint?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[14px] font-medium text-ink">{label}</div>
      {hint && <div className="mt-0.5 break-keep text-[12px] leading-relaxed text-ink-secondary">{hint}</div>}
    </div>
  );
}

export function SwitchRow({ label, hint, aria, on, disabled, className, onToggle, children }: {
  label: string;
  hint?: ReactNode;
  aria?: string;
  on: boolean;
  disabled?: boolean;
  className?: string;
  onToggle: () => void;
  children?: ReactNode;
}) {
  return (
    <div className={DETAILS_ROW}>
      <div className="flex items-center justify-between gap-4">
        <DetailsLabel label={label} hint={hint} />
        <DetailsSwitch on={on} label={aria ?? label} disabled={disabled} className={className} onToggle={onToggle} />
      </div>
      {children}
    </div>
  );
}

function fit(box: HTMLTextAreaElement) {
  if (!box.clientWidth) return;
  // shrinking to measure can clamp the panel's scroll, so put it back before the frame paints
  const scroller = box.closest<HTMLElement>(".overflow-y-auto");
  const top = scroller?.scrollTop ?? 0;
  box.style.height = "auto";
  box.style.height = `${box.scrollHeight + box.offsetHeight - box.clientHeight}px`;
  if (scroller) scroller.scrollTop = top;
}

const metricWatchers = new Set<() => void>();
let metricObserver: MutationObserver | undefined;
let metricFrame: number | undefined;

function scheduleMetrics() {
  if (metricFrame !== undefined) return;
  metricFrame = requestAnimationFrame(() => {
    metricFrame = undefined;
    metricWatchers.forEach((refit) => refit());
  });
}

function stylesheetLoaded(event: Event) {
  if (event.target instanceof HTMLLinkElement) scheduleMetrics();
}

function watchStyleMetrics(refit: () => void) {
  metricWatchers.add(refit);
  if (!metricObserver) {
    metricObserver = new MutationObserver((records) => {
      if (records.some((record) => record.type !== "attributes" || record.target === document.documentElement || record.target instanceof HTMLStyleElement || record.target instanceof HTMLLinkElement)) scheduleMetrics();
    });
    // Keep textarea height writes outside the observed subtree.
    metricObserver.observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true });
    metricObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-skin", "lang", "style", "class"] });
    document.head.addEventListener("load", stylesheetLoaded, true);
  }
  return () => {
    metricWatchers.delete(refit);
    if (metricWatchers.size) return;
    metricObserver?.disconnect();
    metricObserver = undefined;
    document.head.removeEventListener("load", stylesheetLoaded, true);
    if (metricFrame !== undefined) cancelAnimationFrame(metricFrame);
    metricFrame = undefined;
  };
}

/** A textarea as tall as its text, so the panel stays the one thing that scrolls. */
export function FitTextarea({ className, watchMetrics = false, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string; watchMetrics?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (ref.current) fit(ref.current);
  }, [props.value]);
  useEffect(() => {
    let alive = true;
    const refit = () => { if (alive && ref.current) fit(ref.current); };
    void document.fonts?.ready.then(refit);
    document.fonts?.addEventListener("loadingdone", refit);
    return () => {
      alive = false;
      document.fonts?.removeEventListener("loadingdone", refit);
    };
  }, []);
  useEffect(() => {
    if (!watchMetrics || !ref.current) return;
    const box = ref.current;
    const scroller = box.closest<HTMLElement>(".overflow-y-auto");
    const refit = () => fit(box);
    const check = () => { if (box.scrollHeight > box.clientHeight) fit(box); };
    const unwatch = watchStyleMetrics(refit);
    scroller?.addEventListener("scroll", check, { passive: true });
    box.addEventListener("focus", check);
    box.addEventListener("pointerenter", check);
    window.addEventListener("resize", check);
    return () => {
      unwatch();
      scroller?.removeEventListener("scroll", check);
      box.removeEventListener("focus", check);
      box.removeEventListener("pointerenter", check);
      window.removeEventListener("resize", check);
    };
  }, [watchMetrics]);
  useEffect(() => {
    const box = ref.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    let width = box.clientWidth;
    const observer = new ResizeObserver(() => {
      if (box.clientWidth === width) return;
      width = box.clientWidth;
      fit(box);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  return <textarea ref={ref} className={cn(className, "resize-none overflow-hidden")} {...props} />;
}
