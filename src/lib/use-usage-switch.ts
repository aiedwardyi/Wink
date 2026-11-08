import { useLayoutEffect, useRef, useState } from "react";
import { reducedMotion } from "./phone-swipe";

export function useUsageSwitch(checked: boolean) {
  const previous = useRef(checked);
  const [highlight, setHighlight] = useState(false);
  useLayoutEffect(() => {
    const moved = checked && !previous.current;
    previous.current = checked;
    if (!moved || reducedMotion()) { setHighlight(false); return; }
    setHighlight(true);
    const timer = setTimeout(() => setHighlight(false), 600);
    return () => clearTimeout(timer);
  }, [checked]);
  return highlight;
}
