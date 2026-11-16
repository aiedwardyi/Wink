import { createPublicKey, sign } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { googleSubHash } from "../../shared/google-id-token.ts";
import { verifyAccountTicket, verifyTicket } from "../../shared/relay-protocol.ts";
import { loadConfig } from "../src/config.ts";
import type { RelayLimits } from "../src/limits.ts";
import { makePc, openControl, startRelay, type Harness, type Pc } from "./fixtures.ts";
import { makeIssuer, type TestIssuer } from "./google-issuer.ts";
import { createTempDirs } from "../../server/testing/cleanup.ts";

const temps = createTempDirs();
afterAll(() => temps.remove());

const DESKTOP = "desktop-client.apps.googleusercontent.com";
const WEB = "web-client.apps.googleusercontent.com";
const ORIGIN = "https://signin.test";
const DAY = 86_400_000;

let harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses) await h.close();
  harnesses = [];
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: { error?: string; ticket?: string; account?: string; retryAfter?: number } | null;
}

function call(h: Harness, path: string, body: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: h.port,
        servername: `relay.${h.base}`,
        ca: h.ca.certPem,
        method: "POST",
        path,
        agent: false,
        headers: { host: `relay.${h.base}`, "content-type": "application/json" },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (raw += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: raw ? JSON.parse(raw) : null }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

class Clock {
  t = Date.now();
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

interface Setup {
  issuer: TestIssuer;
  clock: Clock;
  limits?: Partial<RelayLimits>;
  dataDir?: string;
  revokedLabelsFile?: string;
}

async function relay(s: Setup): Promise<Harness> {
  const h = await startRelay({
    google: { desktopClientId: DESKTOP, webClientId: WEB, signinOrigin: ORIGIN, keys: s.issuer },
    now: s.clock.now,
    ...(s.dataDir ? { dataDir: s.dataDir } : {}),
    revokedLabelsFile: s.revokedLabelsFile,
    limits: { enrollPerIpPerHour: 1000, ...s.limits },
  });
  harnesses.push(h);
  return h;
}

function token(s: Setup, sub: string, opts: { aud?: string; ageSec?: number; emailVerified?: boolean } = {}): string {
  const iat = Math.floor(s.clock.t / 1000) - (opts.ageSec ?? 0);
  return s.issuer.sign({
    iss: "https://accounts.google.com",
    aud: opts.aud ?? DESKTOP,
    sub,
    email: `${sub}@example.com`,
    email_verified: opts.emailVerified ?? true,
    iat,
    exp: iat + 3600,
  });
}

function enroll(h: Harness, pc: Pc, idToken: string, signer: Pc = pc): Promise<Reply> {
  const payload = Buffer.from(JSON.stringify(["wink-relay-enroll-google/1", idToken, pc.pk]), "utf8");
  const sig = sign(null, payload, signer.privateKey).toString("base64url");
  return call(h, "/v1/enroll/google", JSON.stringify({ idToken, pk: pc.pk, sig }));
}

function setup(limits?: Partial<RelayLimits>): Setup {
  return { issuer: makeIssuer(), clock: new Clock(), limits };
}

describe("POST /v1/enroll/google", () => {
  it("issues a ticket and an account ticket for a fresh desktop token", async () => {
    const s = setup();
    const h = await relay(s);
    const pc = makePc();
    const res = await enroll(h, pc, token(s, "ok-sub", { ageSec: 60 }));
    expect(res.status).toBe(200);
    const operator = createPublicKey(h.operator);
    const ticket = verifyTicket(String(res.body?.ticket), operator, { now: s.clock.t });
    expect(ticket.ok && ticket.value).toMatchObject({ label: pc.label, pk: pc.pk });
    const account = verifyAccountTicket(String(res.body?.account), operator, { now: s.clock.t });
    expect(account.ok && account.value).toMatchObject({ label: pc.label, subHash: googleSubHash("ok-sub") });
    const ctl = await openControl(h, pc, { ticket: String(res.body?.ticket), account: String(res.body?.account) });
    expect(h.relay.hub.pcsFor(googleSubHash("ok-sub"))).toEqual([{ label: pc.label, name: "" }]);
    ctl.socket.destroy();
  });

  it("refuses a stale token", async () => {
    const s = setup();
    const h = await relay(s);
    const res = await enroll(h, makePc(), token(s, "stale-sub", { ageSec: 20 * 60 }));
    expect(res).toMatchObject({ status: 403, body: { error: "token-stale" } });
  });

  it("refuses a web-client token and an unverified email", async () => {
    const s = setup();
    const h = await relay(s);
    expect(await enroll(h, makePc(), token(s, "web-sub", { aud: WEB }))).toMatchObject({ status: 403, body: { error: "bad-audience" } });
    expect(await enroll(h, makePc(), token(s, "unverified-sub", { emailVerified: false }))).toMatchObject({ status: 403, body: { error: "bad-token" } });
  });

  it("refuses a signature by another key", async () => {
    const s = setup();
    const h = await relay(s);
    const res = await enroll(h, makePc(), token(s, "sig-sub"), makePc());
    expect(res).toMatchObject({ status: 403, body: { error: "bad-signature" } });
  });

  it("refuses a revoked label", async () => {
    const s = setup();
    const pc = makePc();
    s.revokedLabelsFile = join(temps.make(join(tmpdir(), "wink-revoked-")), "revoked");
    await writeFile(s.revokedLabelsFile, `${pc.label}\n`);
    const h = await relay(s);
    expect(await enroll(h, pc, token(s, "revoked-sub"))).toMatchObject({ status: 403, body: { error: "revoked" } });
  });

  it("caps one account at 5 pcs and 2 new a day", async () => {
    const s = setup();
    const h = await relay(s);
    const ok = async () => expect((await enroll(h, makePc(), token(s, "busy-sub"))).status).toBe(200);
    await ok();
    await ok();
    const third = await enroll(h, makePc(), token(s, "busy-sub"));
    expect(third).toMatchObject({ status: 403, body: { error: "account-full", retryAfter: 86_400 } });
    expect(third.headers["retry-after"]).toBe("86400");
    s.clock.advance(DAY);
    await ok();
    await ok();
    s.clock.advance(DAY);
    await ok();
    s.clock.advance(DAY);
    const sixth = await enroll(h, makePc(), token(s, "busy-sub"));
    expect(sixth).toMatchObject({ status: 403, body: { error: "account-full" } });
    expect(sixth.body?.retryAfter).toBeUndefined();
    expect((await enroll(h, makePc(), token(s, "other-sub"))).status).toBe(200);
  });

  it("caps new pcs per rolling week and says when a spot frees up", async () => {
    const s = setup({ googleEnrollPerWeek: 3 });
    const h = await relay(s);
    for (let i = 0; i < 3; i++) {
      expect((await enroll(h, makePc(), token(s, `week-sub-${i}`))).status).toBe(200);
      s.clock.advance(3_600_000);
    }
    const full = await enroll(h, makePc(), token(s, "week-sub-late"));
    expect(full).toMatchObject({ status: 503, body: { error: "full", retryAfter: 7 * 86_400 - 3 * 3600 } });
    expect(full.headers["retry-after"]).toBe(String(7 * 86_400 - 3 * 3600));
    s.clock.advance((7 * 86_400 - 3 * 3600) * 1000);
    expect((await enroll(h, makePc(), token(s, "week-sub-late"))).status).toBe(200);
  });

  it("re-enrolls a known key without spending any cap", async () => {
    const s = setup({ googleEnrollPerWeek: 2 });
    const h = await relay(s);
    const pc = makePc();
    for (let i = 0; i < 4; i++) {
      const res = await enroll(h, pc, token(s, "again-sub"));
      expect(res.status).toBe(200);
      s.clock.advance(1000);
    }
    expect((await enroll(h, makePc(), token(s, "again-sub"))).status).toBe(200);
    expect(await enroll(h, makePc(), token(s, "fresh-sub"))).toMatchObject({ status: 503, body: { error: "full" } });
  });

  it("never passes the weekly cap under concurrent requests", async () => {
    const s = setup({ googleEnrollPerWeek: 8 });
    const h = await relay(s);
    const sameAccount = await Promise.all(Array.from({ length: 6 }, () => enroll(h, makePc(), token(s, "race-sub"))));
    expect(sameAccount.filter((r) => r.status === 200)).toHaveLength(2);
    expect(sameAccount.filter((r) => r.body?.error === "account-full")).toHaveLength(4);
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => enroll(h, makePc(), token(s, `race-sub-${i}`))));
    expect(results.filter((r) => r.status === 200)).toHaveLength(6);
    expect(results.filter((r) => r.status === 503 && r.body?.error === "full")).toHaveLength(4);
  });

  it("keeps the journal across a restart", async () => {
    const s = setup({ googleEnrollPerWeek: 2 });
    s.dataDir = temps.make(join(tmpdir(), "wink-relay-journal-"));
    const first = await relay(s);
    const pc = makePc();
    expect((await enroll(first, pc, token(s, "restart-sub"))).status).toBe(200);
    expect((await enroll(first, makePc(), token(s, "restart-other"))).status).toBe(200);
    await first.close();
    harnesses = harnesses.filter((h) => h !== first);
    const second = await relay(s);
    expect(await enroll(second, makePc(), token(s, "restart-third"))).toMatchObject({ status: 503, body: { error: "full" } });
    expect(await enroll(second, makePc(), token(s, "restart-sub"))).toMatchObject({ status: 503, body: { error: "full" } });
    expect((await enroll(second, pc, token(s, "restart-sub"))).status).toBe(200);
  });

  it("never logs the sub, the email or the token", async () => {
    const s = setup({ googleEnrollPerWeek: 1 });
    const h = await relay(s);
    const sub = "secret-sub-123456";
    const tokens = [token(s, sub), token(s, sub, { ageSec: 20 * 60 }), token(s, sub, { aud: WEB })];
    const pc = makePc();
    for (const t of tokens) await enroll(h, pc, t);
    await enroll(h, makePc(), token(s, sub));
    await enroll(h, makePc(), token(s, "someone-else"));
    const logs = h.logs.join("\n");
    expect(logs).toContain("google-enroll");
    expect(logs).not.toContain(sub);
    expect(logs).not.toContain("@example.com");
    expect(logs).not.toContain(googleSubHash(sub));
    for (const t of tokens) expect(logs).not.toContain(t.split(".")[1]);
  });

  it("404s when the config has no google block", async () => {
    const h = await startRelay();
    harnesses.push(h);
    const pc = makePc();
    expect(await call(h, "/v1/enroll/google", JSON.stringify({ idToken: "x", pk: pc.pk, sig: "y" }))).toMatchObject({
      status: 404,
      body: { error: "not-found" },
    });
  });

  it("reads googleEnrollPerWeek from the config file", async () => {
    const path = join(temps.make(join(tmpdir(), "wink-cfg-")), "config.json");
    await writeFile(
      path,
      JSON.stringify({
        base: "wink.example.com",
        acme: { directoryUrl: "https://ca.invalid/directory", termsOfServiceAgreed: true },
        limits: { googleEnrollPerWeek: 20 },
      }),
    );
    expect((await loadConfig(path)).limits?.googleEnrollPerWeek).toBe(20);
  });
});
