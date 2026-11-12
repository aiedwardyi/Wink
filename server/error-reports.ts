import { createHmac } from "node:crypto";
import { ERROR_SITES } from "../shared/error-report.mjs";
import type { TerminalBridgeAccess } from "./terminal-snapshot.ts";

/** The one switch went off on some screen: the desktop app stops crash reports too. */
export const turnOffErrorReports = (access: TerminalBridgeAccess | null) => post(access, { consent: false });

export const reportServerFailure = (access: TerminalBridgeAccess | null, site: number = ERROR_SITES.serverRuntime) => post(access, { code: "SERVER_RUNTIME_FAILURE", site });

async function post(access: TerminalBridgeAccess | null, body: object): Promise<void> {
  if (!access) return;
  try {
    const url = new URL(access.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) return;
    const grant = createHmac("sha256", access.token).update("orbit-error-report-v1").digest("base64url");
    const response = await fetch(`${url.origin}/v1/error-reports`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(2000),
      headers: { authorization: `Bearer ${grant}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    await response.body?.cancel();
  } catch {}
}
