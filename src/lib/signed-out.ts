import { dropSnapshotCache } from "@/state/snapshot-cache";

import { LIVE_EVENTS_PATH } from "./live-events";

/** The relay gate's 401 code once this browser's session is gone (server/phone-access.ts). */
export const SIGNED_OUT = "SIGNED_OUT";

let landing = "/pair";

/** Where this tab goes once signed out: the page a reload reaches, unless its own Sign Out chose the sign-in site. */
export function signedOutLanding(url?: string): void {
  landing = url ?? "/pair";
}

/** Opening the landing page offline would strand the tab on the browser's error page; the live stream's next refusal tries again. `cleared`: the Sign Out reply itself arrived. */
export async function leaveSignedOut(cleared = false): Promise<void> {
  dropSnapshotCache();
  if (!(await reachable(landing))) return;
  // A lost Sign Out reply lost its Clear-Site-Data too; sign-out answers a gone session the same way, so ask again.
  if (!cleared && landing !== "/pair") await fetch("/api/phone/sign-out", { method: "POST", cache: "no-store" }).catch(() => null);
  location.replace(landing);
}

/** Whether `url` answers at all. */
async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { method: "HEAD", mode: "no-cors", cache: "no-store" });
    return true;
  } catch {
    return false;
  }
}

export type SessionState = "gone" | "live" | "unknown";

/** EventSource hides the status, so ask the stream with fetch whether the PC refused this session. Only the PC's own yes or no counts: a dropped socket or a gateway's error says nothing about it. */
export async function sessionState(abort = new AbortController()): Promise<SessionState> {
  try {
    const res = await fetch(LIVE_EVENTS_PATH, { signal: abort.signal, cache: "no-store" });
    if (res.ok && res.headers.get("content-type")?.split(";")[0] === "text/event-stream") return "live";
    if (res.status !== 401) return "unknown";
    const body = await res.json().catch(() => null);
    return body?.code === SIGNED_OUT ? "gone" : "unknown";
  } catch {
    return "unknown";
  } finally {
    abort.abort();
  }
}

const waiting = new Set<() => void>();

/** Watch for a new authenticated stream while the failed reply is being checked. */
export function sessionStreamLive(signal: AbortSignal): Promise<"live"> {
  return new Promise((resolve) => {
    const stop = () => waiting.delete(opened);
    const opened = () => {
      signal.removeEventListener("abort", stop);
      resolve("live");
    };
    waiting.add(opened);
    signal.addEventListener("abort", stop, { once: true });
  });
}

/** The live stream opened. */
export function sessionLive(): void {
  for (const resolve of waiting) resolve();
  waiting.clear();
}
