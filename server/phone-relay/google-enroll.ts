// Joins the relay with this PC's Google sign-in instead of an operator
// invite. One answer brings both the ticket and the account ticket, so the
// front door lists this PC at once.

import { sign } from "node:crypto";
import { z } from "zod";

import { googleSubHash } from "../../shared/google-id-token.ts";
import { ACCOUNT_TOKEN_MAX_AGE_MS, idTokenClaims } from "./account.ts";
import { ENROLL_MAX_BYTES, ENROLL_TIMEOUT_MS } from "./enroll.ts";
import { httpsRequest, type HttpsDeps } from "./https.ts";
import { relayHostFor } from "./mode.ts";
import { accountProblem, loadOrCreateIdentity, ticketProblem, writeAccount, writeTicket } from "./store.ts";

export const GOOGLE_ENROLL_CONTEXT = "wink-relay-enroll-google/1";

const googleEnrollResponseSchema = z.object({ ticket: z.string().min(1).max(16 * 1024), account: z.string().min(1).max(4096) });
const googleEnrollErrorSchema = z.object({ error: z.string().regex(/^[a-z0-9-]{1,64}$/) });

export type GoogleJoinError = "relay-full" | "relay-unavailable" | "signed-out" | "enroll-failed";
export type GoogleJoinResult = { ok: true } | { ok: false; error: GoogleJoinError; reason: string };

export interface GoogleEnrollOptions {
  dataDir: string;
  base: string;
  /** This PC's Google sign-in. */
  sub(): string | null | undefined;
  idToken(): string | null;
  freshIdToken(): Promise<string | null>;
}

export interface GoogleEnrollDeps {
  https?: HttpsDeps;
  now?: () => number;
}

/** Bytes the Google enroll signature covers. */
export function googleEnrollPayload(idToken: string, pk: string): Buffer {
  return Buffer.from(JSON.stringify([GOOGLE_ENROLL_CONTEXT, idToken, pk]), "utf8");
}

const refused = (error: GoogleJoinError, reason: string): GoogleJoinResult => ({ ok: false, error, reason });

/** The held token while the relay would still take it, else a refreshed one. */
async function joinToken(options: GoogleEnrollOptions, sub: string, now: number): Promise<string | null> {
  const held = options.idToken();
  const claims = held ? idTokenClaims(held) : null;
  if (held && claims?.sub === sub && now - claims.iat <= ACCOUNT_TOKEN_MAX_AGE_MS) return held;
  const fresh = await options.freshIdToken().catch(() => null);
  return fresh && idTokenClaims(fresh)?.sub === sub ? fresh : null;
}

export async function enrollWithGoogle(options: GoogleEnrollOptions, deps: GoogleEnrollDeps = {}): Promise<GoogleJoinResult> {
  const now = deps.now ?? Date.now;
  const sub = options.sub();
  const idToken = sub ? await joinToken(options, sub, now()) : null;
  if (!sub || !idToken) return refused("signed-out", "no Google sign-in on this PC");

  const identity = loadOrCreateIdentity(options.dataDir);
  const sig = sign(null, googleEnrollPayload(idToken, identity.pk), identity.privateKey).toString("base64url");
  let res;
  try {
    res = await httpsRequest(
      {
        method: "POST",
        url: `https://${relayHostFor(options.base)}/v1/enroll/google`,
        body: JSON.stringify({ idToken, pk: identity.pk, sig }),
        timeoutMs: ENROLL_TIMEOUT_MS,
        maxBytes: ENROLL_MAX_BYTES,
      },
      deps.https,
    );
  } catch (cause) {
    return refused("relay-unavailable", `relay unreachable: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(res.body.toString("utf8"));
  } catch {
    body = undefined;
  }
  if (res.status !== 200) {
    const code = googleEnrollErrorSchema.safeParse(body).data?.error;
    const reason = `relay refused enrollment (${res.status}${code ? ` ${code}` : ""})`;
    if (code === "full" || code === "account-full") return refused("relay-full", reason);
    return refused(res.status === 404 ? "relay-unavailable" : "enroll-failed", reason);
  }
  const parsed = googleEnrollResponseSchema.safeParse(body);
  if (!parsed.success) return refused("enroll-failed", "relay sent an unreadable enrollment answer");
  const ticketIssue = ticketProblem(parsed.data.ticket, identity, now());
  if (ticketIssue) return refused("enroll-failed", `relay sent an unusable ticket: ${ticketIssue}`);
  const accountIssue = accountProblem(parsed.data.account, identity, googleSubHash(sub), now());
  if (accountIssue) return refused("enroll-failed", `relay sent an unusable account ticket: ${accountIssue}`);
  writeTicket(options.dataDir, parsed.data.ticket);
  writeAccount(options.dataDir, parsed.data.account);
  return { ok: true };
}
