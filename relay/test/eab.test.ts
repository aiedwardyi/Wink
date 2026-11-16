import { generateKeyPairSync, randomBytes, verify, type KeyObject } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { configSchema, loadGts } from "../src/config.ts";
import { signEabRequest, type EabRequest, type ServiceAccount } from "../src/eab.ts";
import { makeOperator, makePc, startRelay, ticketFor, type Harness, type Pc } from "./fixtures.ts";
import { createTempDirs } from "../../server/testing/cleanup.ts";

const temps = createTempDirs();
afterAll(() => temps.remove());

const PROJECT = "wink-relay-test";
const TOKEN_URI = "https://oauth2.googleapis.test/token";
const MINT_URL = `https://publicca.googleapis.com/v1/projects/${PROJECT}/locations/global/externalAccountKeys`;

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: { kid?: string; hmacKey?: string; error?: string; retryAfter?: number } | null;
}

function post(harness: Harness, body: EabRequest): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: harness.port,
        servername: `relay.${harness.base}`,
        ca: harness.ca.certPem,
        method: "POST",
        path: "/v1/acme/eab",
        agent: false,
        headers: { host: `relay.${harness.base}`, "content-type": "application/json" },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (raw += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: raw ? JSON.parse(raw) : null }));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

interface FakeGoogle {
  account: ServiceAccount;
  privatePem: string;
  fetch: typeof fetch;
  tokens: number;
  mints: number;
  macKeys: Buffer[];
  failMint: boolean;
}

function fakeGoogle(): FakeGoogle {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const google: FakeGoogle = {
    account: { clientEmail: "relay@wink-relay-test.iam.gserviceaccount.com", privateKey, tokenUri: TOKEN_URI },
    privatePem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    tokens: 0,
    mints: 0,
    macKeys: [],
    failMint: false,
    fetch: async (input, init) => {
      const url = String(input);
      if (url === TOKEN_URI) {
        const form = new URLSearchParams(String(init?.body));
        expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
        const [header, payload, sig] = form.get("assertion")!.split(".");
        expect(verify("sha256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(sig, "base64url"))).toBe(true);
        const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        expect(claims).toMatchObject({ iss: google.account.clientEmail, aud: TOKEN_URI, scope: "https://www.googleapis.com/auth/cloud-platform" });
        expect(claims.exp - claims.iat).toBe(3600);
        google.tokens++;
        return Response.json({ access_token: `token-${google.tokens}`, expires_in: 3600, token_type: "Bearer" });
      }
      if (url === MINT_URL) {
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer token-${google.tokens}`);
        if (google.failMint) return Response.json({ error: { code: 500 } }, { status: 500 });
        google.mints++;
        // 0xfb 0xff bytes make standard base64 carry "+" and "/".
        const mac = Buffer.concat([Buffer.from([0xfb, 0xff, 0xfe]), randomBytes(29)]);
        google.macKeys.push(mac);
        // b64MacKey is a bytes field holding base64url text, so REST JSON base64-encodes that text again.
        const b64MacKey = Buffer.from(mac.toString("base64url")).toString("base64");
        return Response.json({ name: `projects/${PROJECT}/locations/global/externalAccountKeys/k${google.mints}`, keyId: `kid${google.mints}`, b64MacKey });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  };
  return google;
}

function eabBody(pc: Pc, operator: KeyObject, opts: { iat?: number; signer?: KeyObject; ticketPc?: Pc } = {}): EabRequest {
  const ticket = ticketFor(opts.ticketPc ?? pc, operator);
  const iat = opts.iat ?? Math.floor(Date.now() / 1000);
  return { ticket, pk: pc.pk, iat, sig: signEabRequest(opts.signer ?? pc.privateKey, ticket, pc.pk, iat) };
}

async function start(google: FakeGoogle, extra: { perHour?: number; perLabelPerDay?: number; now?: () => number; revokedLabelsFile?: string } = {}) {
  const operator = makeOperator();
  return startRelay({
    operatorPrivateKey: operator,
    gts: { project: PROJECT, perHour: extra.perHour ?? 60, perLabelPerDay: extra.perLabelPerDay ?? 2, account: google.account, fetch: google.fetch },
    limits: { enrollPerIpPerHour: 100 },
    now: extra.now,
    revokedLabelsFile: extra.revokedLabelsFile,
  });
}

describe("POST /v1/acme/eab", () => {
  it("mints one GTS key per call and hands the HMAC key over as base64url", async () => {
    const google = fakeGoogle();
    h = await start(google);
    const pc = makePc();
    const res = await post(h, eabBody(pc, h.operator));
    expect(res.status).toBe(200);
    expect(res.body?.kid).toBe("kid1");
    expect(res.body?.hmacKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(res.body!.hmacKey!, "base64url").equals(google.macKeys[0])).toBe(true);
    await h.waitLog((entry) => entry.event === "eab-issued" && entry.count === 1);
  });

  it("answers 404 without a gts block, and loadGts reads no file", async () => {
    h = await startRelay({ limits: { enrollPerIpPerHour: 100 } });
    const pc = makePc();
    const res = await post(h, eabBody(pc, h.operator));
    expect(res).toMatchObject({ status: 404, body: { error: "not-found" } });

    const config = configSchema.parse({ base: "relay-test.example", acme: { directoryUrl: "https://acme.test/dir", termsOfServiceAgreed: true } });
    await expect(loadGts(config, { CREDENTIALS_DIRECTORY: join(tmpdir(), "wink-no-such-credentials") })).resolves.toBeUndefined();
  });

  it("reads the service account from the systemd credential", async () => {
    const google = fakeGoogle();
    const dir = temps.make(join(tmpdir(), "wink-gts-cred-"));
    await writeFile(
      join(dir, "gts.json"),
      JSON.stringify({ type: "service_account", client_email: google.account.clientEmail, private_key: google.privatePem, token_uri: TOKEN_URI }),
      { mode: 0o600 },
    );
    const config = configSchema.parse({
      base: "relay-test.example",
      acme: { directoryUrl: "https://acme.test/dir", termsOfServiceAgreed: true },
      gts: { project: PROJECT },
    });
    const gts = await loadGts(config, { CREDENTIALS_DIRECTORY: dir });
    expect(gts).toMatchObject({ project: PROJECT, perHour: 60, perLabelPerDay: 2, account: { clientEmail: google.account.clientEmail, tokenUri: TOKEN_URI } });
    await expect(loadGts(config, { CREDENTIALS_DIRECTORY: join(tmpdir(), "wink-no-such-credentials") })).rejects.toThrow(/gts/);
  });

  it("refuses a bad signature", async () => {
    const google = fakeGoogle();
    h = await start(google);
    const pc = makePc();
    const res = await post(h, eabBody(pc, h.operator, { signer: makePc().privateKey }));
    expect(res).toMatchObject({ status: 403, body: { error: "bad-signature" } });
    expect(google.mints).toBe(0);
  });

  it("refuses a stale request", async () => {
    const google = fakeGoogle();
    h = await start(google);
    const pc = makePc();
    const res = await post(h, eabBody(pc, h.operator, { iat: Math.floor(Date.now() / 1000) - 600 }));
    expect(res).toMatchObject({ status: 403, body: { error: "stale" } });
    expect(google.mints).toBe(0);
  });

  it("refuses a key that is not the ticket's", async () => {
    const google = fakeGoogle();
    h = await start(google);
    const pc = makePc();
    const res = await post(h, eabBody(pc, h.operator, { ticketPc: makePc() }));
    expect(res).toMatchObject({ status: 403, body: { error: "key-mismatch" } });
    expect(google.mints).toBe(0);
  });

  it("refuses a ticket from another operator", async () => {
    const google = fakeGoogle();
    h = await start(google);
    const pc = makePc();
    const res = await post(h, eabBody(pc, makeOperator()));
    expect(res).toMatchObject({ status: 403, body: { error: "ticket-invalid" } });
  });

  it("refuses a revoked label", async () => {
    const google = fakeGoogle();
    const pc = makePc();
    const file = join(temps.make(join(tmpdir(), "wink-revoked-")), "revoked");
    await writeFile(file, `${pc.label}\n`);
    h = await start(google, { revokedLabelsFile: file });
    const res = await post(h, eabBody(pc, h.operator));
    expect(res).toMatchObject({ status: 403, body: { error: "revoked" } });
    expect(google.mints).toBe(0);
  });

  it("caps keys per label per day with retryAfter", async () => {
    const google = fakeGoogle();
    h = await start(google, { perLabelPerDay: 2 });
    const pc = makePc();
    expect((await post(h, eabBody(pc, h.operator))).status).toBe(200);
    expect((await post(h, eabBody(pc, h.operator))).status).toBe(200);
    const full = await post(h, eabBody(pc, h.operator));
    expect(full).toMatchObject({ status: 429, body: { error: "full" } });
    expect(full.body!.retryAfter).toBeGreaterThan(86_000);
    expect(full.body!.retryAfter).toBeLessThanOrEqual(86_400);
    expect(google.mints).toBe(2);
    expect((await post(h, eabBody(makePc(), h.operator))).status).toBe(200);
  });

  it("caps keys for the whole relay per hour with retryAfter", async () => {
    const google = fakeGoogle();
    h = await start(google, { perHour: 2 });
    expect((await post(h, eabBody(makePc(), h.operator))).status).toBe(200);
    expect((await post(h, eabBody(makePc(), h.operator))).status).toBe(200);
    const full = await post(h, eabBody(makePc(), h.operator));
    expect(full).toMatchObject({ status: 429, body: { error: "full" } });
    expect(full.body!.retryAfter).toBeGreaterThan(3_500);
    expect(full.body!.retryAfter).toBeLessThanOrEqual(3_600);
    expect(google.mints).toBe(2);
  });

  it("answers 502 when Google fails, and the failed call spends no budget", async () => {
    const google = fakeGoogle();
    h = await start(google, { perLabelPerDay: 1 });
    const pc = makePc();
    google.failMint = true;
    expect(await post(h, eabBody(pc, h.operator))).toMatchObject({ status: 502, body: { error: "ca-unavailable" } });
    google.failMint = false;
    expect((await post(h, eabBody(pc, h.operator))).status).toBe(200);
  });

  it("reuses the access token until a minute before it expires", async () => {
    const google = fakeGoogle();
    let now = Date.now();
    h = await start(google, { now: () => now });
    const body = () => {
      const pc = makePc();
      const ticket = ticketFor(pc, h!.operator);
      const iat = Math.floor(now / 1000);
      return { ticket, pk: pc.pk, iat, sig: signEabRequest(pc.privateKey, ticket, pc.pk, iat) };
    };
    expect((await post(h, body())).status).toBe(200);
    expect((await post(h, body())).status).toBe(200);
    expect(google).toMatchObject({ tokens: 1, mints: 2 });
    now += 3_600_000 - 59_000;
    expect((await post(h, body())).status).toBe(200);
    expect(google).toMatchObject({ tokens: 2, mints: 3 });
  });

  it("never logs the HMAC key, the service account key, the token or the label", async () => {
    const google = fakeGoogle();
    h = await start(google, { perLabelPerDay: 1 });
    const pc = makePc();
    const res = await post(h, eabBody(pc, h.operator));
    await post(h, eabBody(pc, h.operator));
    await h.waitLog((entry) => entry.event === "eab-rejected");
    const text = h.logs.join("\n");
    expect(text).not.toContain(res.body!.hmacKey!);
    expect(text).not.toContain(google.macKeys[0].toString("base64"));
    expect(text).not.toContain("token-1");
    expect(text).not.toContain(google.privatePem.split("\n")[1]);
    const eabLines = h.logs.filter((line) => line.includes("eab-"));
    expect(eabLines.length).toBeGreaterThanOrEqual(2);
    for (const line of eabLines) expect(line).not.toContain(pc.label);
  });
});
