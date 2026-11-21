import { LIVE_EVENTS_PATH } from "./live-events";

/** The relay gate's 401 code once this browser's session is gone (server/phone-access.ts). */
export const SIGNED_OUT = "SIGNED_OUT";

let landing = "/pair";

/** Where this tab goes once signed out: the page a reload reaches, unless its own Sign Out chose the sign-in site. */
export function signedOutLanding(url?: string): void {
  landing = url ?? "/pair";
}

export function leaveSignedOut(): void {
  location.replace(landing);
}

export type SessionState = "gone" | "live" | "unreachable";

/** EventSource hides the status, so ask the stream with fetch whether the relay refused this session. */
export async function sessionState(): Promise<SessionState> {
  const abort = new AbortController();
  try {
    const res = await fetch(LIVE_EVENTS_PATH, { signal: abort.signal, cache: "no-store" });
    if (res.status !== 401) return "live";
    const body = await res.json().catch(() => null);
    return body?.code === SIGNED_OUT ? "gone" : "live";
  } catch {
    return "unreachable";
  } finally {
    abort.abort();
  }
}
