// Lazy screens, Activity's numbers, first-use faces and the markdown parser, warmed once the first chat is up, so a first open paints like the second.
import { isPhone } from "./phone-swipe";
import { faceWarms } from "./warm-faces";

interface Connection {
  saveData?: boolean;
  type?: string;
}

type Load = () => Promise<unknown>;

const EXTRAS: Load[] = [
  ...faceWarms,
  () => import("@/components/ChatMarkdown").then((m) => m.warmMarkdown()),
  () => import("@/components/MemoryMap"),
  () => import("@/components/ActivityCard").then((m) => m.warmActivity()),
  () => import("@/components/PhoneAccessSettings").then((m) => m.warmRelay()),
];

/** A phone warms only on Wi-Fi or an unknown link; Save-Data always skips. */
export function warmAllowed(connection: Connection | undefined, phone: boolean): boolean {
  if (connection?.saveData) return false;
  return !phone || !connection?.type || connection.type === "wifi" || connection.type === "unknown";
}

/** One load per idle slot, so no warm-up stacks into a long task; returns a cancel. */
export function warmViews(views: Load[], extras = EXTRAS): () => void {
  const loads = [...views, ...extras];
  if (!warmAllowed((navigator as Navigator & { connection?: Connection }).connection, isPhone())) return () => {};
  let idle: number | undefined;
  let timer = 0;
  let cancelled = false;
  const next = (index: number) => {
    if (cancelled || index >= loads.length) return;
    const run = () => {
      idle = undefined;
      timer = 0;
      void loads[index]!().catch(() => {}).finally(() => next(index + 1));
    };
    idle = window.requestIdleCallback?.(run, { timeout: 2000 });
    if (idle == null) timer = window.setTimeout(run, 1);
  };
  next(0);
  return () => {
    cancelled = true;
    if (idle != null) window.cancelIdleCallback?.(idle);
    if (timer) window.clearTimeout(timer);
  };
}
