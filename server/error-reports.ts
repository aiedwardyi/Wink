import { createHmac } from "node:crypto";
import { ERROR_SITES } from "../shared/error-report.mjs";
import type { TerminalBridgeAccess } from "./terminal-snapshot.ts";

let offs = 0;

/** The one switch went off on some screen: the desktop app stops crash reports too. Asked again until it says yes or the switch goes back on. */
export async function turnOffErrorReports(access: TerminalBridgeAccess | null, waits = [1000, 5000, 30_000, 120_000]): Promise<void> {
  const mine = ++offs;
  for (const wait of [0, ...waits]) {
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait).unref());
    if (mine !== offs || await post(access, { consent: false })) return;
  }
}

/** The switch went back on: an off still being asked must not land after it. */
export const keepErrorReports = () => { offs++; };

export const reportServerFailure = (access: TerminalBridgeAccess | null, site: number = ERROR_SITES.serverRuntime) => post(access, { code: "SERVER_RUNTIME_FAILURE", site });

async function post(access: TerminalBridgeAccess | null, body: object): Promise<boolean> {
  if (!access) return true;
  try {
    const url = new URL(access.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) return true;
    const grant = createHmac("sha256", access.token).update("orbit-error-report-v1").digest("base64url");
    const response = await fetch(`${url.origin}/v1/error-reports`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(2000),
      headers: { authorization: `Bearer ${grant}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}
