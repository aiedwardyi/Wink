// POST /v1/acme/eab {ticket, pk, iat, sig} -> {kid, hmacKey}: one Google Trust Services
// External Account Binding key per call, for a PC that Let's Encrypt rate-limited.
// `sig` is by the PC key over UTF-8 JSON.stringify(["wink-relay-eab/1", ticket, pk, iat]).
// One EAB key registers exactly one ACME account, so each PC needs its own.

import { createPrivateKey, sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { CLOCK_SKEW_SEC, ED25519_SIG_BYTES, publicKeyFromRaw, rawPublicKey, verifyTicket } from "../../shared/relay-protocol.ts";
import type { Logger } from "./log.ts";

export const EAB_CONTEXT = "wink-relay-eab/1";
export const GTS_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const PUBLICCA = "https://publicca.googleapis.com/v1";
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** A cached access token is dropped this long before Google says it expires. */
const TOKEN_MARGIN_MS = 60_000;
const GOOGLE_TIMEOUT_MS = 15_000;
const MAX_LABELS = 65_536;

const B64URL = /^[A-Za-z0-9_-]+$/;

export const eabRequestSchema = z.strictObject({
  ticket: z.string().min(1).max(4096),
  pk: z.string().length(43).regex(B64URL),
  iat: z.int(),
  sig: z.string().length(86).regex(B64URL),
});

export type EabRequest = z.infer<typeof eabRequestSchema>;

export type EabResult =
  | { ok: true; kid: string; hmacKey: string }
  | { ok: false; status: number; error: string; retryAfter?: number };

export const BAD_EAB_REQUEST: EabResult = { ok: false, status: 400, error: "bad-request" };

export interface ServiceAccount {
  clientEmail: string;
  privateKey: KeyObject;
  tokenUri: string;
}

export interface GtsOptions {
  /** GCP project id that owns the Public CA EAB keys. */
  project: string;
  perHour: number;
  perLabelPerDay: number;
  account: ServiceAccount;
  /** Tests inject a fake Google. */
  fetch?: typeof fetch;
}

/** Bytes the EAB request signature covers. */
export function eabPayload(ticket: string, pk: string, iat: number): Buffer {
  return Buffer.from(JSON.stringify([EAB_CONTEXT, ticket, pk, iat]), "utf8");
}

/** PC side: signs a /v1/acme/eab request with the PC identity key. */
export function signEabRequest(privateKey: KeyObject, ticket: string, pk: string, iat: number): string {
  return sign(null, eabPayload(ticket, pk, iat), privateKey).toString("base64url");
}

const serviceAccountSchema = z.object({
  client_email: z.email(),
  private_key: z.string().min(1),
  token_uri: z.url({ protocol: /^https$/ }),
});

/** Parses a Google service account JSON key. Errors never echo key material. */
export function parseServiceAccount(text: string): ServiceAccount {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("gts key file is not valid JSON");
  }
  const parsed = serviceAccountSchema.safeParse(json);
  if (!parsed.success) throw new Error("gts key file is not a service account key");
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: parsed.data.private_key, format: "pem" });
  } catch {
    throw new Error("gts key file holds no readable private key");
  }
  if (privateKey.asymmetricKeyType !== "rsa") throw new Error("gts key must be RSA");
  return { clientEmail: parsed.data.client_email, privateKey, tokenUri: parsed.data.token_uri };
}

const tokenSchema = z.object({ access_token: z.string().min(1).max(4096), expires_in: z.number().positive() });
const keySchema = z.object({ keyId: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/), b64MacKey: z.base64() });

class GoogleError extends Error {}

export class EabIssuer {
  private readonly opts: GtsOptions;
  private readonly operatorPublicKey: KeyObject;
  private readonly isRevoked: (label: string) => boolean;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly fetch: typeof fetch;
  /** Mint times, oldest first, for the whole relay (last hour) and per label (last day). */
  private hourly: number[] = [];
  private readonly daily = new Map<string, number[]>();
  private token: { value: string; until: number } | null = null;
  private issued = 0;

  constructor(opts: GtsOptions, deps: { operatorPublicKey: KeyObject; isRevoked: (label: string) => boolean; log: Logger; now: () => number }) {
    this.opts = opts;
    this.operatorPublicKey = deps.operatorPublicKey;
    this.isRevoked = deps.isRevoked;
    this.log = deps.log;
    this.now = deps.now;
    this.fetch = opts.fetch ?? fetch;
  }

  /** Callers parse the body with eabRequestSchema first. */
  async issue(req: EabRequest): Promise<EabResult> {
    const now = this.now();
    const opened = verifyTicket(req.ticket, this.operatorPublicKey, { now });
    if (!opened.ok) return fail(403, opened.reason === "expired" ? "ticket-expired" : "ticket-invalid");
    const publicKey = publicKeyFromRaw(req.pk);
    if (!publicKey) return fail(400, "bad-key");
    const ticketKey = publicKeyFromRaw(opened.value.pk);
    if (!ticketKey || !rawPublicKey(publicKey).equals(rawPublicKey(ticketKey))) return fail(403, "key-mismatch");
    const sig = Buffer.from(req.sig, "base64url");
    if (sig.length !== ED25519_SIG_BYTES || !safeVerify(publicKey, eabPayload(req.ticket, req.pk, req.iat), sig)) {
      return fail(403, "bad-signature");
    }
    if (Math.abs(Math.floor(now / 1000) - req.iat) > CLOCK_SKEW_SEC) return fail(403, "stale");
    const label = opened.value.label;
    if (this.isRevoked(label)) return fail(403, "revoked");

    this.hourly = this.hourly.filter((at) => at > now - HOUR_MS);
    const mine = (this.daily.get(label) ?? []).filter((at) => at > now - DAY_MS);
    if (mine.length >= this.opts.perLabelPerDay) return full(mine[0] + DAY_MS - now);
    if (this.hourly.length >= this.opts.perHour) return full(this.hourly[0] + HOUR_MS - now);
    // Spent before the await so concurrent requests never pass a cap; refunded on failure.
    this.hourly.push(now);
    mine.push(now);
    this.daily.delete(label);
    if (this.daily.size >= MAX_LABELS) this.daily.delete(this.daily.keys().next().value!);
    this.daily.set(label, mine);

    try {
      const key = await this.mint();
      this.issued++;
      this.log.log("eab-issued", { count: this.issued });
      return { ok: true, ...key };
    } catch (error) {
      drop(this.hourly, now);
      drop(this.daily.get(label), now);
      if (!(error instanceof GoogleError)) throw error;
      return fail(502, "ca-unavailable");
    }
  }

  private async mint(): Promise<{ kid: string; hmacKey: string }> {
    const token = await this.accessToken();
    const res = await this.call(`${PUBLICCA}/projects/${this.opts.project}/locations/global/externalAccountKeys`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    if (res.status === 401) this.token = null;
    const key = res.ok ? await read(res, keySchema) : null;
    if (!key) throw new GoogleError("mint");
    // b64MacKey is a bytes field holding base64url text, so REST JSON base64-encodes that text again.
    const hmacKey = Buffer.from(key.b64MacKey, "base64").toString("utf8");
    if (!/^[A-Za-z0-9_-]{16,512}$/.test(hmacKey)) throw new GoogleError("mint");
    return { kid: key.keyId, hmacKey };
  }

  private async accessToken(): Promise<string> {
    const now = this.now();
    if (this.token && now < this.token.until) return this.token.value;
    const { clientEmail, privateKey, tokenUri } = this.opts.account;
    const iat = Math.floor(now / 1000);
    const part = (value: Record<string, string | number>) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iss: clientEmail, scope: GTS_SCOPE, aud: tokenUri, iat, exp: iat + 3600 })}`;
    const assertion = `${unsigned}.${sign("sha256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
    const res = await this.call(tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    });
    const token = res.ok ? await read(res, tokenSchema) : null;
    if (!token) throw new GoogleError("token");
    this.token = { value: token.access_token, until: now + token.expires_in * 1000 - TOKEN_MARGIN_MS };
    return this.token.value;
  }

  private async call(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS) });
    } catch {
      throw new GoogleError("network");
    }
  }
}

async function read<T>(res: Response, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const parsed = schema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function safeVerify(key: KeyObject, data: Buffer, sig: Buffer): boolean {
  try {
    return verify(null, data, key, sig);
  } catch {
    return false;
  }
}

function drop(list: number[] | undefined, at: number): void {
  const index = list?.indexOf(at) ?? -1;
  if (index >= 0) list!.splice(index, 1);
}

function fail(status: number, error: string): EabResult {
  return { ok: false, status, error };
}

function full(waitMs: number): EabResult {
  return { ok: false, status: 429, error: "full", retryAfter: Math.max(1, Math.ceil(waitMs / 1000)) };
}
