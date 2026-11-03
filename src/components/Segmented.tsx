import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

function edgeFade(el: HTMLElement): string | undefined {
  const start = el.scrollLeft > 1;
  const end = el.scrollWidth - el.clientWidth - el.scrollLeft > 1;
  if (!start && !end) return undefined;
  return `linear-gradient(to right, ${start ? "transparent" : "black"}, black 24px, black calc(100% - 24px), ${end ? "transparent" : "black"})`;
}

export interface SegmentedProps<T extends string> {
  label: string;
  value: T;
  options: Array<{ id: T; label: string }>;
  onChange: (id: T) => void;
  disabled?: (id: T) => boolean;
  title?: string;
}

export function Segmented<T extends string>({ label, value, options, onChange, disabled, title }: SegmentedProps<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);
  const [mask, setMask] = useState<string | undefined>();
  useLayoutEffect(() => {
    const group = ref.current;
    if (!group) return;
    const place = () => {
      const on = group.querySelector<HTMLElement>('[aria-checked="true"]');
      setThumb(on ? { x: on.offsetLeft, w: on.offsetWidth } : null);
      setMask(edgeFade(group));
    };
    place();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(place);
    observer.observe(group);
    for (const button of group.querySelectorAll("button")) observer.observe(button);
    return () => observer.disconnect();
  }, [value, options]);
  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={label}
      title={title}
      onScroll={(e) => setMask(edgeFade(e.currentTarget))}
      className="relative flex w-fit min-w-0 max-w-full shrink-0 gap-0.5 overflow-x-auto rounded-lg bg-inset p-[3px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={{ maskImage: mask, WebkitMaskImage: mask }}
    >
      {thumb && (
        <span
          aria-hidden
          data-segmented-thumb
          className="pointer-events-none absolute inset-y-[3px] left-0 rounded-[max(0px,calc(var(--radius-lg)_-_3px))] bg-raised shadow-sm ring-1 ring-hairline/60 transition-[transform,width]"
          style={{ width: thumb.w, transform: `translateX(${thumb.x}px)` }}
        />
      )}
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          disabled={disabled?.(option.id) ?? false}
          onClick={() => onChange(option.id)}
          className={cn(
            "relative shrink-0 whitespace-nowrap rounded-[max(0px,calc(var(--radius-lg)_-_3px))] px-2 py-1 text-[12.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus disabled:opacity-40",
            value === option.id ? "text-ink" : "text-ink-secondary enabled:hover:text-ink",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function SegmentedRow<T extends string>({ hint, ...props }: SegmentedProps<T> & { hint?: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className={cn("flex-1 break-keep", hint ? "min-w-[min(100%,12rem)]" : "min-w-min")}>
        <div className="text-[14px] font-medium text-ink">{props.label}</div>
        {hint && <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{hint}</div>}
      </div>
      <Segmented {...props} />
    </div>
  );
}
