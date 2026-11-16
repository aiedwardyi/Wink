// Asks the relay for a Google Trust Services EAB key, so this PC can open its
// own account at the second CA when Let's Encrypt is rate-limited. One key
// opens one ACME account, so each PC gets its own.

import { sign } from "node:crypto";
import { z } from "zod";

import type { AcmeExternalAccount } from "./acme.ts";
import { httpsRequest, type HttpsDeps } from "./https.ts";
import { relayHostFor } from "./mode.ts";
import type { Identity } from "./store.ts";

export const EAB_CONTEXT = "wink-relay-eab/1";
export const EAB_TIMEOUT_MS = 15_000;
export const EAB_MAX_BYTES = 4 * 1024;

const eabResponseSchema = z.object({
  kid: z.string().min(1).max(512),
  hmacKey: z.string().regex(/^[A-Za-z0-9_-]{16,512}$/),
});
const fullSchema = z.object({ error: z.literal("full"), retryAfter: z.number().nonnegative() });
const errorSchema = z.object({ error: z.string().regex(/^[a-z0-9-]{1,64}$/) });

/** The relay has no keys left for now. */
export class EabFullError extends Error {
  constructor(readonly retryAt: number) {
    super("relay has no second-CA keys left for now");
  }
}

/** Bytes the EAB request signature covers. */
export function eabPayload(ticket: string, pk: string, iat: number): Buffer {
  return Buffer.from(JSON.stringify([EAB_CONTEXT, ticket, pk, iat]), "utf8");
}

export interface RequestEabOptions {
  base: string;
  identity: Identity;
  ticket: string;
  now: number;
}

/** A fresh EAB key, or null when the relay offers no second CA. Throws EabFullError when out of keys. */
export async function requestEab(options: RequestEabOptions, https?: HttpsDeps): Promise<AcmeExternalAccount | null> {
  const { identity, ticket, now } = options;
  const iat = Math.floor(now / 1000);
  const sig = sign(null, eabPayload(ticket, identity.pk, iat), identity.privateKey).toString("base64url");
  const res = await httpsRequest(
    {
      method: "POST",
      url: `https://${relayHostFor(options.base)}/v1/acme/eab`,
      body: JSON.stringify({ ticket, pk: identity.pk, iat, sig }),
      timeoutMs: EAB_TIMEOUT_MS,
      maxBytes: EAB_MAX_BYTES,
    },
    https,
  );
  if (res.status === 404) return null;
  let body: unknown;
  try {
    body = JSON.parse(res.body.toString("utf8"));
  } catch {
    body = undefined;
  }
  if (res.status === 429) {
    const full = fullSchema.safeParse(body);
    if (full.success) throw new EabFullError(now + full.data.retryAfter * 1000);
  }
  if (res.status !== 200) {
    const code = errorSchema.safeParse(body);
    throw new Error(`relay refused a second-CA key (${res.status}${code.success ? ` ${code.data.error}` : ""})`);
  }
  const parsed = eabResponseSchema.safeParse(body);
  if (!parsed.success) throw new Error("relay sent an unreadable second-CA key");
  return parsed.data;
}
