import { useEffect, useRef, useState, type RefObject } from "react";
import { Brain } from "lucide-react";
import { watchMemoryArrival } from "@/lib/memory-clean-events";
import "./MemoryMotion.css";

export const reducedMemoryMotion = () => typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

export function MemoryCleanIcon({ botId, active }: { botId: string; active: boolean }) {
  const [ripple, setRipple] = useState(false);
  const last = useRef(-Infinity);
  useEffect(() => {
    if (!active) { setRipple(false); return; }
    return watchMemoryArrival(botId, () => {
      if (reducedMemoryMotion() || Date.now() - last.current < 600) return;
      last.current = Date.now();
      setRipple(true);
    });
  }, [botId, active]);
  return <span className="mc-icon"><Brain size={15} aria-hidden="true" />{ripple && <span className="mc-ripple" onAnimationEnd={() => setRipple(false)} />}</span>;
}

export function MemoryCleanTint({ nonce, row }: { nonce: number; row: RefObject<HTMLElement | null> }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    setVisible(true);
    row.current?.scrollIntoView?.({ block: "center", behavior: "instant" });
    const timer = window.setTimeout(() => setVisible(false), 2000);
    return () => window.clearTimeout(timer);
  }, [nonce, row]);
  return visible ? <span className="mc-tint" aria-hidden="true" onAnimationEnd={() => setVisible(false)} /> : null;
}
