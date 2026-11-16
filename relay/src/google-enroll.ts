// POST /v1/enroll/google {idToken, pk, sig} -> {ticket, account}: a fresh desktop Google token stands in for an invite.
// `sig` is by the PC key over UTF-8 JSON.stringify(["wink-relay-enroll-google/1", idToken, pk]).
// Every new label costs a public certificate under the base, so new labels are capped
// per Google account, per account per day and relay-wide per rolling week. A known key re-enrolls for free.

import { sign, verify, type KeyObject } from "node:crypto";
import { mkdir, open, rename } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { googleSubHash } from "../../shared/google-id-token.ts";
import {
  ED25519_SIG_BYTES,
  labelForPublicKey,
  publicKeyFromRaw,
  rawPublicKey,
  signAccountTicket,
  signTicket,
} from "../../shared/relay-protocol.ts";
import type { Accounts } from "./accounts.ts";
import { TICKET_TTL_SEC } from "./enroll.ts";
import type { RelayLimits } from "./limits.ts";

export const GOOGLE_ENROLL_CONTEXT = "wink-relay-enroll-google/1";
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** Bytes the enrollment signature covers. */
export function googleEnrollPayload(idToken: string, pk: string): Buffer {
  return Buffer.from(JSON.stringify([GOOGLE_ENROLL_CONTEXT, idToken, pk]), "utf8");
}

/** PC side: signs a /v1/enroll/google request with the PC identity key. */
export function signGoogleEnrollment(privateKey: KeyObject, idToken: string, pk: string): string {
  return sign(null, googleEnrollPayload(idToken, pk), privateKey).toString("base64url");
}

const B64URL = /^[A-Za-z0-9_-]+$/;
export const googleEnrollRequestSchema = z.strictObject({
  idToken: z.string().min(1).max(8192),
  pk: z.string().length(43).regex(B64URL),
  sig: z.string().length(86).regex(B64URL),
});

export type GoogleEnrollRequest = z.infer<typeof googleEnrollRequestSchema>;

/** `waitMs` is set when the relay-wide week is full: the exact time until a spot frees. */
type Denied = { ok: false; status: number; error: string; retryAfter?: number; waitMs?: number };

export type GoogleEnrollResult = { ok: true; label: string; fresh: boolean; ticket: string; account: string } | Denied;

export const BAD_GOOGLE_ENROLL: GoogleEnrollResult = { ok: false, status: 400, error: "bad-request" };

/** `durable` settles once the label's journal line is on disk, or rejects if it never got there. */
type Claim = { ok: true; fresh: boolean; durable: Promise<void> } | Denied;

const FILE = "google-enrolls";
const LINE_RE = /^([a-z2-7]{16}) ([A-Za-z0-9_-]{43}) (\d{1,15})$/;
const MAX_FILE_BYTES = 16 * 1024 * 1024;

/** Labels enrolled through Google: "<label> <subHash> <ms>" lines, never pruned, since the per-account cap is for all time. */
export class GoogleEnrollJournal {
  private readonly byLabel = new Map<string, { subHash: string; at: number }>();
  /** Labels whose line is not known to be on disk. A failed write stays here, so its label never gets a ticket. */
  private readonly unwritten = new Map<string, Promise<void>>();
  private readonly path: string;
  private writes: Promise<void> = Promise.resolve();

  private constructor(dir: string) {
    this.path = join(dir, FILE);
  }

  static async open(dir: string): Promise<GoogleEnrollJournal> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const journal = new GoogleEnrollJournal(dir);
    let text = "";
    try {
      const handle = await open(journal.path, "r");
      try {
        if ((await handle.stat()).size > MAX_FILE_BYTES) throw new Error("google-enrolls file is too large");
        text = await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
    } catch (error) {
      // SAFETY: fs rejects with Node errno errors.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const line of text.split("\n")) {
      const m = LINE_RE.exec(line);
      if (m && !journal.byLabel.has(m[1])) journal.byLabel.set(m[1], { subHash: m[2], at: Number(m[3]) });
    }
    // Rewritten whole so a line torn by a crash cannot swallow the next append.
    await journal.rewrite();
    return journal;
  }

  /**
   * Checks every cap and marks the label in one synchronous turn, so concurrent
   * enrollments cannot both take the last spot.
   */
  claim(label: string, subHash: string, now: number, limits: RelayLimits): Claim {
    if (this.byLabel.has(label)) return { ok: true, fresh: false, durable: this.unwritten.get(label) ?? Promise.resolve() };
    const mine: number[] = [];
    const week: number[] = [];
    for (const entry of this.byLabel.values()) {
      if (entry.subHash === subHash) mine.push(entry.at);
      if (entry.at > now - WEEK_MS) week.push(entry.at);
    }
    if (mine.length >= limits.googleEnrollPerAccount) return { ok: false, status: 403, error: "account-full" };
    const today = mine.filter((at) => at > now - DAY_MS);
    if (today.length >= limits.googleEnrollPerAccountPerDay) {
      return { ok: false, status: 403, error: "account-full", retryAfter: seconds(freesIn(today, limits.googleEnrollPerAccountPerDay, DAY_MS, now)) };
    }
    if (week.length >= limits.googleEnrollPerWeek) {
      const waitMs = freesIn(week, limits.googleEnrollPerWeek, WEEK_MS, now);
      return { ok: false, status: 503, error: "full", retryAfter: seconds(waitMs), waitMs };
    }
    this.byLabel.set(label, { subHash, at: now });
    const durable = this.append(`${label} ${subHash} ${now}\n`);
    this.unwritten.set(label, durable);
    durable.then(
      () => this.unwritten.delete(label),
      () => {},
    );
    return { ok: true, fresh: true, durable };
  }

  private append(line: string): Promise<void> {
    const write = this.writes.then(async () => {
      const handle = await open(this.path, "a", 0o600);
      try {
        await handle.appendFile(line, "utf8");
        await handle.datasync();
      } finally {
        await handle.close();
      }
    });
    this.writes = write.catch(() => {});
    return write;
  }

  private async rewrite(): Promise<void> {
    let text = "";
    for (const [label, { subHash, at }] of this.byLabel) text += `${label} ${subHash} ${at}\n`;
    const tmp = `${this.path}.tmp`;
    const handle = await open(tmp, "w", 0o600);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, this.path);
  }
}

/** Ms until enough entries leave the window to free one spot under `cap`. */
function freesIn(ats: number[], cap: number, windowMs: number, now: number): number {
  ats.sort((a, b) => a - b);
  return ats[Math.max(0, ats.length - cap)] + windowMs - now;
}

function seconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

export interface GoogleEnrollerOptions {
  accounts: Accounts;
  journal: GoogleEnrollJournal;
  operatorPrivateKey: KeyObject;
  isRevoked: (label: string) => boolean;
  limits: RelayLimits;
  now?: () => number;
  ticketTtlSec?: number;
}

export class GoogleEnroller {
  private readonly opts: GoogleEnrollerOptions;
  private waiting = 0;

  constructor(opts: GoogleEnrollerOptions) {
    this.opts = opts;
  }

  /** Claims a spot, holding the request while the week is full and a spot frees within googleEnrollWaitMs. */
  private async claim(label: string, subHash: string): Promise<Claim> {
    const { journal, limits } = this.opts;
    const now = this.opts.now ?? Date.now;
    // The hold sleeps on real timers, so real time bounds it whatever clock `now` is.
    const giveUp = Date.now() + limits.googleEnrollWaitMs;
    for (;;) {
      const claim = journal.claim(label, subHash, now(), limits);
      if (claim.ok || claim.waitMs === undefined) return claim;
      // Negated so a NaN wait (a cap of 0) is refused too.
      if (!(Date.now() + claim.waitMs <= giveUp) || this.waiting >= limits.googleEnrollMaxWaiting) return claim;
      this.waiting++;
      try {
        await sleep(claim.waitMs);
      } finally {
        this.waiting--;
      }
    }
  }

  /** Callers parse the body with googleEnrollRequestSchema first (BAD_GOOGLE_ENROLL when it fails). */
  async enroll(req: GoogleEnrollRequest): Promise<GoogleEnrollResult> {
    const clock = this.opts.now ?? Date.now;
    let now = clock();
    const publicKey = publicKeyFromRaw(req.pk);
    if (!publicKey) return fail(400, "bad-key");
    const sigBytes = Buffer.from(req.sig, "base64url");
    if (sigBytes.length !== ED25519_SIG_BYTES || !safeVerify(publicKey, googleEnrollPayload(req.idToken, req.pk), sigBytes)) {
      return fail(403, "bad-signature");
    }
    const raw = rawPublicKey(publicKey);
    const label = labelForPublicKey(raw);
    if (this.opts.isRevoked(label)) return fail(403, "revoked");

    const claims = await this.opts.accounts.desktop(req.idToken, now);
    if (!claims.ok) return claims;
    if (!claims.token.emailVerified) return fail(403, "bad-token");
    const subHash = googleSubHash(claims.token.sub);

    const claim = await this.claim(label, subHash);
    if (!claim.ok) return { ok: false, status: claim.status, error: claim.error, retryAfter: claim.retryAfter };

    now = clock();
    const iat = Math.floor(now / 1000);
    const exp = iat + (this.opts.ticketTtlSec ?? TICKET_TTL_SEC);
    const ticket = signTicket({ label, pk: raw.toString("base64url"), iat, exp }, this.opts.operatorPrivateKey);
    const account = signAccountTicket({ label, subHash, iat, exp }, this.opts.operatorPrivateKey);
    try {
      await claim.durable;
    } catch {
      // No ticket without a durable entry, so a restart can never forget a spent spot.
      return fail(503, "store-unavailable");
    }
    return { ok: true, label, fresh: claim.fresh, ticket, account };
  }
}

function safeVerify(key: KeyObject, data: Buffer, sig: Buffer): boolean {
  try {
    return verify(null, data, key, sig);
  } catch {
    return false;
  }
}

function fail(status: number, error: string): Denied {
  return { ok: false, status, error };
}
