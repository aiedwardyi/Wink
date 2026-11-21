import { LIVE_EVENTS_PATH } from "./live-events";

/** The relay gate's 401 code once this browser's session is gone (server/phone-access.ts). */
export const SIGNED_OUT = "SIGNED_OUT";

let landing = "/pair";

/** Where this tab goes once signed out: the page a reload reaches, unless its own Sign Out chose the sign-in site. */
export function signedOutLanding(url?: string): void {
  landing = url ?? "/pair";
}

/** Opening the landing page offline would strand the tab on the browser's error page; the live stream's next refusal tries again. */
export async function leaveSignedOut(): Promise<void> {
  if (await reachable(landing)) location.replace(landing);
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
export async function sessionState(): Promise<SessionState> {
  const abort = new AbortController();
  try {
    const res = await fetch(LIVE_EVENTS_PATH, { signal: abort.signal, cache: "no-store" });
    if (res.ok) return "live";
    if (res.status !== 401) return "unknown";
    const body = await res.json().catch(() => null);
    return body?.code === SIGNED_OUT ? "gone" : "unknown";
  } catch {
    return "unknown";
  } finally {
    abort.abort();
  }
}

let streamOpen = false;
const waiting = new Set<() => void>();

/** Resolves when the live stream opens, or at once if `already` and it is open: the PC's word that it still has this session, since it cuts a signed-out session's streams before it answers. */
export function sessionStreamLive(already = true): Promise<void> {
  if (already && streamOpen) return Promise.resolve();
  return new Promise((resolve) => {
    waiting.add(resolve);
  });
}

/** The live stream opened. */
export function sessionLive(): void {
  streamOpen = true;
  for (const resolve of waiting) resolve();
  waiting.clear();
}

/** The live stream closed. */
export function sessionStreamClosed(): void {
  streamOpen = false;
}
