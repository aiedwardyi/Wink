import { useCallback, useRef, useSyncExternalStore } from "react";
import { CHAT_MIN_WIDTH, SIDEBAR_MAX_WIDTH } from "./sidebar-preferences";

export function useSidebarViewportWidth(asideWidth: number): number {
  // Snapshot checks run during commits, when a viewport read would force layout.
  const width = useRef<number | null>(null);
  if (width.current === null) width.current = window.innerWidth;
  const subscribe = useCallback((onChange: () => void) => {
    const resize = () => {
      width.current = window.innerWidth;
      onChange();
    };
    window.addEventListener("resize", resize);
    resize();
    return () => window.removeEventListener("resize", resize);
  }, []);
  // Wider viewports cannot change a fitted sidebar.
  const read = () => Math.min(width.current!, CHAT_MIN_WIDTH + SIDEBAR_MAX_WIDTH + asideWidth);
  return useSyncExternalStore(subscribe, read, read);
}
