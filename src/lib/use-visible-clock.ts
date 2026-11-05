import { useEffect, useSyncExternalStore } from "react";

const MINUTE = 60_000;
const SECOND = 1000;
const listeners = new Set<() => void>();
let seconds = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

function schedule() {
  clearTimeout(timer);
  timer = undefined;
  if (listeners.size === 0 || document.visibilityState === "hidden") return;
  const step = seconds > 0 ? SECOND : MINUTE;
  timer = setTimeout(tick, step - (Date.now() % step));
}
function tick() {
  listeners.forEach((listener) => listener());
  schedule();
}
function onVisible() {
  if (document.visibilityState === "visible") tick();
  else schedule();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) document.addEventListener("visibilitychange", onVisible);
  schedule();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) document.removeEventListener("visibilitychange", onVisible);
    schedule();
  };
}
const minuteNow = () => Math.floor(Date.now() / MINUTE) * MINUTE;
const secondNow = () => Math.floor(Date.now() / SECOND) * SECOND;

/** One clock for every visible surface: minute ticks, seconds only while a caller asks for them. Stops while hidden. */
export function useVisibleClock(wantSeconds = false): number {
  useEffect(() => {
    if (!wantSeconds) return;
    seconds += 1;
    schedule();
    return () => {
      seconds -= 1;
      schedule();
    };
  }, [wantSeconds]);
  return useSyncExternalStore(subscribe, wantSeconds ? secondNow : minuteNow, wantSeconds ? secondNow : minuteNow);
}
