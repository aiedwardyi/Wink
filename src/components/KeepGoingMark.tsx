import { useId } from "react";
import { cn } from "@/lib/cn";
import type { Bot } from "@/state/store";

export type KeepGoingMarkState = "on" | "paused";

export function keepGoingMarkState(bot: Pick<Bot, "keepGoing">): KeepGoingMarkState | null {
  if (!bot.keepGoing) return null;
  return bot.keepGoing.paused ? "paused" : "on";
}

const GLYPH_STROKE = "M6 6C5.2 5.1 4.8 4.7 4.2 4.7a1.6 1.3 0 0 0 0 2.6c.6 0 1-.4 1.8-1.3s1.2-1.3 1.8-1.3a1.6 1.3 0 0 1 0 2.6c-.6 0-1-.4-1.8-1.3z";

function Glyph({ color }: { color: string }) {
  return <path fill="none" stroke={color} strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" d={GLYPH_STROKE} />;
}

// Solid when on (gray when off), hollow when paused; the glyph is cut out, so it shows the ground behind it.
export function KeepGoingMark({ state, size = 12, className }: { state: KeepGoingMarkState | "off"; size?: number; className?: string }) {
  const mask = `kgm${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" className={cn("block shrink-0", state === "off" ? "text-ink-secondary" : "text-accent-text", className)} aria-hidden>
      {state !== "paused" ? (
        <>
          <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="12" height="12">
            <circle cx="6" cy="6" r="6" fill="#fff" />
            <Glyph color="#000" />
          </mask>
          <circle cx="6" cy="6" r="6" fill="currentColor" mask={`url(#${mask})`} />
        </>
      ) : (
        <>
          <circle cx="6" cy="6" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <Glyph color="currentColor" />
        </>
      )}
    </svg>
  );
}
