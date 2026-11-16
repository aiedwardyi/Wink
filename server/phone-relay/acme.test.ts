import { X509Certificate, createHash, createPrivateKey } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { join } from "node:path";
import { createSecureContext } from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CertManager, FALLBACK_AFTER_MS, RENEW_CHECK_MS, RETRY_BASE_MS, STEP_TIMEOUT_MS, type AcmeAccountConfig, type AcmeExternalAccount, type ChallengeTarget } from "./acme.ts";
import { EabFullError } from "./eab.ts";
import { readAcmeState, readCert, readKeyHistory, relayDir, spkiFingerprint, writeCert } from "./store.ts";
import { FakeAcme } from "./testing/fake-acme.ts";
import { FakeClock } from "./testing/fake-clock.ts";
import { tempDataDir } from "./testing/harness.ts";
import { listenLocal } from "./testing/net.ts";
import { TestCa, inspectChallengeCert, leafFingerprint, type KeyAndCert } from "./testing/pki.ts";

const HOST = "abcdefghijklmnop.wink.test";
const DAY = 24 * 60 * 60_000;

class Target implements ChallengeTarget {
  cert: KeyAndCert | null = null;
  challenge: KeyAndCert | null = null;
  readonly challenges: KeyAndCert[] = [];
  readonly installs: string[] = [];

  setCertificate(keyPem: string, certPem: string): void {
    this.cert = { keyPem, certPem };
    this.installs.push(leafFingerprint(certPem));
  }

  setChallenge(keyPem: string, certPem: string): void {
    this.challenge = { keyPem, certPem };
    this.challenges.push(this.challenge);
  }

  clearChallenge(): void {
    this.challenge = null;
  }
}

/** Validator for the fake CA that reads the target directly, recording what it saw. */
function directValidator(target: Target, seen: Array<{ keyAuthorization: string; ok: boolean }>) {
  return async (host: string, keyAuthorization: string) => {
    const current = target.challenge;
    let ok = false;
    if (current) {
      const info = inspectChallengeCert(current.certPem);
      const expected = Buffer.concat([Buffer.from([0x04, 0x20]), createHash("sha256").update(keyAuthorization).digest()]);
      ok = info.critical && info.otherNames === 0 && info.dnsNames.length === 1 && info.dnsNames[0] === host && info.value.equals(expected);
    }
    seen.push({ keyAuthorization, ok });
    return ok;
  };
}

describe("ACME certificate manager", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function setup(options: { directories?: FakeAcme[]; accounts?: Record<string, AcmeAccountConfig>; clock?: FakeClock } = {}) {
    const { dir, cleanup } = tempDataDir();
    cleanups.push(cleanup);
    const ca = await TestCa.create();
    const acmes = options.directories ?? [await FakeAcme.start({ ca })];
    for (const acme of acmes) cleanups.push(() => acme.close());
    const clock = options.clock ?? new FakeClock();
    const target = new Target();
    const events = new EventEmitter();
    const certs = new CertManager({
      dataDir: dir,
      host: HOST,
      directories: acmes.map((acme) => acme.directoryUrl),
      accounts: options.accounts ?? {},
      clock,
      target,
      onChange: () => events.emit("change"),
      allowInsecureDirectories: true,
    });
    cleanups.push(() => certs.stop());
    /** Resolves when the next issuance attempt has started and finished. */
    const settled = () =>
      new Promise<void>((resolve) => {
        let started = false;
        const check = () => {
          if (certs.snapshot().issuing) started = true;
          if (!started || certs.snapshot().issuing) return;
          events.off("change", check);
          resolve();
        };
        events.on("change", check);
      });
    return { dir, ca, acmes, clock, target, certs, events, settled };
  }

  it("issues through tls-alpn-01 with an RFC 8737 challenge certificate and cleans up", async () => {
    const { dir, acmes, target, certs, settled } = await setup();
    const seen: Array<{ keyAuthorization: string; ok: boolean }> = [];
    acmes[0].validator = directValidator(target, seen);
    certs.start();
    const done = settled();
    certs.setConnected(true);
    await done;

    expect(seen).toHaveLength(1);
    expect(seen[0].ok).toBe(true);
    const [challenge] = target.challenges;
    const info = inspectChallengeCert(challenge.certPem);
    expect(info.dnsNames).toEqual([HOST]);
    expect(info.otherNames).toBe(0);
    expect(info.critical).toBe(true);
    expect(info.value.subarray(0, 2)).toEqual(Buffer.from([0x04, 0x20]));
    expect(info.value.subarray(2)).toEqual(createHash("sha256").update(seen[0].keyAuthorization).digest());
    expect(new X509Certificate(challenge.certPem).checkPrivateKey(createPrivateKey(challenge.keyPem))).toBe(true);

    expect(acmes[0].log).toContain("challenge:tls-alpn-01");
    expect(acmes[0].log).not.toContain("challenge:http-01");
    expect(acmes[0].log).not.toContain("challenge:dns-01");
    expect(target.challenge).toBeNull();

    const stored = readCert(dir, HOST);
    expect(stored.kind).toBe("ok");
    if (stored.kind !== "ok") return;
    expect(target.cert?.certPem).toBe(stored.value.certPem);
    expect(readKeyHistory(dir)).toContain(spkiFingerprint(createPrivateKey(stored.value.keyPem)));
    expect(certs.snapshot()).toMatchObject({ valid: true, issuing: false, error: null, notAfter: stored.value.notAfter });
    if (process.platform !== "win32") {
      expect(statSync(relayDir(dir)).mode & 0o777).toBe(0o700);
      for (const name of readdirSync(relayDir(dir))) expect(statSync(join(relayDir(dir), name)).mode & 0o777).toBe(0o600);
    }
  });

  it("makes a short-lived self-signed challenge certificate that BoringSSL loads", async () => {
    const { acmes, clock, target, certs, settled } = await setup();
    const seen: Array<{ keyAuthorization: string; ok: boolean }> = [];
    acmes[0].validator = directValidator(target, seen);
    certs.start();
    const done = settled();
    certs.setConnected(true);
    await done;

    expect(seen).toEqual([{ keyAuthorization: expect.any(String), ok: true }]);
    const [challenge] = target.challenges;
    expect(() => createSecureContext({ key: challenge.keyPem, cert: challenge.certPem })).not.toThrow();
    const info = inspectChallengeCert(challenge.certPem);
    expect(info.keyUsage).toEqual({ usages: ["digitalSignature"], critical: true });
    expect(info.dnsNames).toEqual([HOST]);
    expect(info.otherNames).toBe(0);
    expect(info.critical).toBe(true);
    const digest = createHash("sha256").update(seen[0].keyAuthorization).digest();
    expect(info.value).toEqual(Buffer.concat([Buffer.from([0x04, 0x20]), digest]));
    const cert = new X509Certificate(challenge.certPem);
    expect(cert.ca).toBe(false);
    expect(cert.issuer).toBe(cert.subject);
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(cert.publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(cert.checkPrivateKey(createPrivateKey(challenge.keyPem))).toBe(true);
    expect(cert.validFromDate.getTime()).toBeLessThanOrEqual(clock.now());
    expect(cert.validToDate.getTime()).toBeGreaterThan(clock.now());
    expect(cert.validToDate.getTime() - cert.validFromDate.getTime()).toBeLessThanOrEqual(DAY);
  });

  it("keeps the current certificate when renewal fails, then renews without a restart", async () => {
    const { dir, ca, acmes, clock, target, certs, settled } = await setup();
    acmes[0].validator = directValidator(target, []);
    const old = await ca.issue(HOST, { notBefore: new Date(clock.now() - 80 * DAY), notAfter: new Date(clock.now() + 10 * DAY) });
    writeCert(dir, old.keyPem, old.certPem);
    const oldFile = readFileSync(join(relayDir(dir), "cert.json"), "utf8");
    certs.start();
    expect(target.installs).toEqual([leafFingerprint(old.certPem)]);

    acmes[0].mode = "reject";
    let done = settled();
    certs.setConnected(true);
    await done;
    expect(certs.snapshot()).toMatchObject({ valid: true });
    expect(certs.snapshot().error).toContain("certificate request failed");
    expect(target.installs).toEqual([leafFingerprint(old.certPem)]);
    expect(readFileSync(join(relayDir(dir), "cert.json"), "utf8")).toBe(oldFile);
    expect(target.challenge).toBeNull();

    acmes[0].mode = "ok";
    clock.advance(RETRY_BASE_MS - 1);
    expect(acmes[0].log.filter((entry) => entry === "new-order")).toHaveLength(0);
    done = settled();
    clock.advance(1);
    await done;
    expect(certs.snapshot().error).toBeNull();
    expect(target.installs).toHaveLength(2);
    expect(target.installs[1]).not.toBe(target.installs[0]);
  });

  it("logs a corrupt retry state file instead of reporting it as a certificate error", async () => {
    const { dir, ca, certs } = await setup();
    const current = await ca.issue(HOST);
    writeCert(dir, current.keyPem, current.certPem);
    writeFileSync(join(relayDir(dir), "acme-state.json"), "{");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    cleanups.push(() => warn.mockRestore());
    certs.start();
    expect(certs.snapshot()).toMatchObject({ valid: true, error: null });
    expect(warn).toHaveBeenCalledWith("phone relay: ACME retry state not loaded (ACME state file is corrupt)");
  });

  it("keeps the current certificate when the CA hands back an expired one", async () => {
    const { dir, ca, acmes, clock, target, certs, settled } = await setup();
    acmes[0].validator = directValidator(target, []);
    const old = await ca.issue(HOST, { notBefore: new Date(clock.now() - 80 * DAY), notAfter: new Date(clock.now() + 10 * DAY) });
    writeCert(dir, old.keyPem, old.certPem);
    const oldFile = readFileSync(join(relayDir(dir), "cert.json"), "utf8");
    acmes[0].validity = () => ({ notBefore: new Date(clock.now() - 91 * DAY), notAfter: new Date(clock.now() - DAY) });
    certs.start();
    const done = settled();
    certs.setConnected(true);
    await done;
    expect(acmes[0].log).toContain("issued");
    expect(target.installs).toEqual([leafFingerprint(old.certPem)]);
    expect(readFileSync(join(relayDir(dir), "cert.json"), "utf8")).toBe(oldFile);
  });

  it("reports an invalid challenge and clears it", async () => {
    const { acmes, target, certs, settled } = await setup();
    acmes[0].validator = async () => false;
    certs.start();
    const done = settled();
    certs.setConnected(true);
    await done;
    expect(certs.snapshot()).toMatchObject({ valid: false, error: "certificate request failed: authorization invalid" });
    expect(target.challenges).toHaveLength(1);
    expect(target.challenge).toBeNull();
    expect(target.cert).toBeNull();
  });

  it("falls back to the next CA after three days, with separate account keys and EAB only where configured", async () => {
    const ca = await TestCa.create();
    const eab = { kid: "kid-123", hmacKey: Buffer.alloc(32, 9).toString("base64url") };
    const first = await FakeAcme.start({ ca });
    const second = await FakeAcme.start({ ca, eab });
    first.mode = "reject";
    const { dir, clock, target, certs, settled } = await setup({
      directories: [first, second],
      accounts: { [second.directoryUrl]: { eab, contact: ["mailto:ops@wink.test"] } },
    });
    second.validator = directValidator(target, []);
    certs.start();
    let done = settled();
    certs.setConnected(true);
    await done;
    const start = clock.now();
    while (clock.now() - start < FALLBACK_AFTER_MS + 13 * 60 * 60_000 && target.cert === null) {
      const next = clock.nextAt;
      if (next === null) break;
      done = settled();
      clock.advance(next - clock.now());
      await done;
    }
    expect(target.cert).not.toBeNull();
    expect(first.log.filter((entry) => entry === "error:rejectedIdentifier").length).toBeGreaterThanOrEqual(3);
    expect(second.log).toContain("issued");
    expect(first.eabSeen).toEqual([]);
    expect(second.eabSeen).toEqual(["kid-123"]);
    expect(first.accountKeys.size).toBe(1);
    expect(second.accountKeys.size).toBe(1);
    expect([...first.accountKeys][0]).not.toBe([...second.accountKeys][0]);
    expect(readdirSync(relayDir(dir)).filter((name) => name.startsWith("acme-account-"))).toHaveLength(2);
  });

  it("still falls back to the next CA when Wink restarts every day", async () => {
    const ca = await TestCa.create();
    const first = await FakeAcme.start({ ca });
    const second = await FakeAcme.start({ ca });
    cleanups.push(() => first.close(), () => second.close());
    first.mode = "reject";
    const { dir, cleanup } = tempDataDir();
    cleanups.push(cleanup);
    const clock = new FakeClock();
    const target = new Target();
    second.validator = directValidator(target, []);
    const start = clock.now();
    for (let day = 1; day <= 5 && target.cert === null; day++) {
      const events = new EventEmitter();
      const certs = new CertManager({
        dataDir: dir,
        host: HOST,
        directories: [first.directoryUrl, second.directoryUrl],
        accounts: {},
        clock,
        target,
        onChange: () => events.emit("change"),
        allowInsecureDirectories: true,
      });
      const idle = () => vi.waitFor(() => expect(certs.snapshot().issuing).toBe(false));
      certs.start();
      certs.setConnected(true);
      await idle();
      const dayEnd = start + day * DAY;
      for (let next = clock.nextAt; next !== null && next <= dayEnd && target.cert === null; next = clock.nextAt) {
        clock.advance(next - clock.now());
        await idle();
      }
      certs.stop();
      clock.advance(dayEnd - clock.now());
    }
    expect(first.log.filter((entry) => entry === "error:rejectedIdentifier").length).toBeGreaterThanOrEqual(3);
    expect(second.log).toContain("issued");
  });

  it("renews early when the CA's ARI window has opened", async () => {
    const { dir, cleanup } = tempDataDir();
    cleanups.push(cleanup);
    const ca = await TestCa.create();
    const acme = await FakeAcme.start({ ca });
    cleanups.push(() => acme.close());
    const clock = new FakeClock();
    const target = new Target();
    acme.validator = directValidator(target, []);
    // The fake CA plus an RFC 9773 renewalInfo resource whose window opened yesterday.
    const shim = createServer((req, res) => {
      if (req.url !== "/directory") {
        const window = { start: new Date(clock.now() - DAY).toISOString(), end: new Date(clock.now() - DAY / 2).toISOString() };
        res.writeHead(200, { "content-type": "application/json", "retry-after": "21600" }).end(JSON.stringify({ suggestedWindow: window }));
        return;
      }
      void fetch(acme.directoryUrl)
        .then((answer) => answer.json())
        .then((directory) => {
          const renewalInfo = `http://127.0.0.1:${shimPort}/renewal-info`;
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(Object.assign({}, directory, { renewalInfo })));
        });
    });
    const shimPort = await listenLocal(shim);
    cleanups.push(() => {
      shim.closeAllConnections();
      shim.close();
    });
    const current = await ca.issue(HOST);
    writeCert(dir, current.keyPem, current.certPem);
    const events = new EventEmitter();
    const certs = new CertManager({
      dataDir: dir,
      host: HOST,
      directories: [`http://127.0.0.1:${shimPort}/directory`],
      accounts: {},
      clock,
      target,
      onChange: () => events.emit("change"),
      allowInsecureDirectories: true,
    });
    cleanups.push(() => certs.stop());
    certs.start();
    certs.setConnected(true);
    const renewed = new Promise<boolean>((resolve) => events.on("change", () => target.installs.length > 1 && resolve(true)));
    clock.advance(RENEW_CHECK_MS);
    expect(await Promise.race([renewed, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000))])).toBe(true);
  });

  it("stop() during a renewal writes nothing and goes quiet", async () => {
    const { dir, acmes, clock, target, certs, events } = await setup();
    acmes[0].validator = directValidator(target, []);
    acmes[0].mode = "hold";
    const held = new Promise<void>((resolve) => (acmes[0].onHold = resolve));
    certs.start();
    certs.setConnected(true);
    await held;
    certs.stop();
    let changes = 0;
    events.on("change", () => changes++);
    acmes[0].release();
    await new Promise<void>((resolve) => {
      const check = () => (acmes[0].log.includes("issued") ? resolve() : setImmediate(check));
      check();
    });
    clock.advance(30 * DAY);
    expect(changes).toBe(0);
    expect(readCert(dir, HOST).kind).toBe("missing");
    expect(target.cert).toBeNull();
    expect(target.challenge).toBeNull();
    expect(clock.pending).toBe(0);
  });

  it("refuses a plain-http directory outside tests", async () => {
    const { dir, cleanup } = tempDataDir();
    cleanups.push(cleanup);
    const target = new Target();
    const events = new EventEmitter();
    const certs = new CertManager({
      dataDir: dir,
      host: HOST,
      directories: ["http://127.0.0.1:9/directory"],
      accounts: {},
      clock: new FakeClock(),
      target,
      onChange: () => events.emit("change"),
    });
    cleanups.push(() => certs.stop());
    certs.start();
    const done = new Promise<void>((resolve) => events.on("change", () => certs.snapshot().error && resolve()));
    certs.setConnected(true);
    await done;
    expect(certs.snapshot().error).toBe("certificate request failed: ACME directory must be https");
  });
});

describe("ACME step deadline", () => {
  it("gives up on a CA that never answers and retries later", async () => {
    const { dir, cleanup } = tempDataDir();
    const silent = createServer(() => {});
    const port = await listenLocal(silent);
    const clock = new FakeClock();
    const events = new EventEmitter();
    const certs = new CertManager({
      dataDir: dir,
      host: HOST,
      directories: [`http://127.0.0.1:${port}/directory`],
      accounts: {},
      clock,
      target: new Target(),
      onChange: () => events.emit("change"),
      allowInsecureDirectories: true,
    });
    try {
      certs.start();
      const failed = new Promise<void>((resolve) => events.on("change", () => certs.snapshot().error && resolve()));
      certs.setConnected(true);
      await new Promise<void>((resolve) => silent.once("request", () => resolve()));
      clock.advance(STEP_TIMEOUT_MS);
      await failed;
      expect(certs.snapshot()).toMatchObject({ issuing: false, error: "certificate request failed: CA did not answer in time" });
      expect(clock.nextAt).toBe(clock.now() + RETRY_BASE_MS);
    } finally {
      certs.stop();
      silent.closeAllConnections();
      silent.close();
      cleanup();
    }
  });

  it("stop() ends a CA request that is still waiting", async () => {
    const { dir, cleanup } = tempDataDir();
    const silent = createServer(() => {});
    const port = await listenLocal(silent);
    const certs = new CertManager({
      dataDir: dir,
      host: HOST,
      directories: [`http://127.0.0.1:${port}/directory`],
      accounts: {},
      clock: new FakeClock(),
      target: new Target(),
      onChange: () => {},
      allowInsecureDirectories: true,
    });
    try {
      certs.start();
      const asked = new Promise<IncomingMessage>((resolve) => silent.once("request", resolve));
      certs.setConnected(true);
      const req = await asked;
      certs.stop();
      const ended = await Promise.race([once(req.socket, "close").then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000))]);
      expect(ended).toBe(true);
    } finally {
      certs.stop();
      silent.closeAllConnections();
      silent.close();
      cleanup();
    }
  });
});

describe("second CA on a rate limit", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
  });

  const EAB = { kid: "kid-gts", hmacKey: Buffer.alloc(32, 7).toString("base64url") };

  async function setup(externalAccount: () => Promise<AcmeExternalAccount | null>) {
    const { dir, cleanup } = tempDataDir();
    cleanups.push(cleanup);
    const ca = await TestCa.create();
    const le = await FakeAcme.start({ ca });
    const gts = await FakeAcme.start({ ca, eab: EAB });
    cleanups.push(() => le.close(), () => gts.close());
    const clock = new FakeClock();
    const target = new Target();
    le.validator = directValidator(target, []);
    gts.validator = directValidator(target, []);
    const events = new EventEmitter();
    const asked = vi.fn(externalAccount);
    const certs = new CertManager({
      dataDir: dir,
      host: HOST,
      directories: [le.directoryUrl],
      accounts: {},
      fallback: { directory: gts.directoryUrl, externalAccount: asked },
      clock,
      target,
      onChange: () => events.emit("change"),
      allowInsecureDirectories: true,
    });
    cleanups.push(() => certs.stop());
    const settled = () =>
      new Promise<void>((resolve) => {
        let started = false;
        const check = () => {
          if (certs.snapshot().issuing) started = true;
          if (!started || certs.snapshot().issuing) return;
          events.off("change", check);
          resolve();
        };
        events.on("change", check);
      });
    const run = async () => {
      const done = settled();
      certs.setConnected(true);
      await done;
    };
    return { dir, le, gts, clock, target, certs, asked, run, settled };
  }

  it("uses Let's Encrypt when it answers", async () => {
    const { le, gts, target, certs, asked, run } = await setup(async () => EAB);
    certs.start();
    await run();
    expect(target.cert).not.toBeNull();
    expect(le.log).toContain("issued");
    expect(gts.log).toEqual([]);
    expect(asked).not.toHaveBeenCalled();
  });

  it("turns to the second CA with a relay EAB key when Let's Encrypt is rate-limited, and renews there", async () => {
    const { dir, le, gts, target, certs, asked, run } = await setup(async () => EAB);
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    le.mode = "limited";
    certs.start();
    await run();
    expect(le.log).toContain("error:rateLimited");
    expect(gts.log).toContain("issued");
    expect(gts.eabSeen).toEqual(["kid-gts"]);
    expect(asked).toHaveBeenCalledTimes(1);
    expect(target.cert).not.toBeNull();
    expect(certs.snapshot()).toMatchObject({ valid: true, error: null, fullUntil: null });
    const line = logs.mock.calls.map((call) => String(call[0])).find((text) => text.includes("certificates issued"));
    expect(line).toBe("phone relay: certificates issued, first CA 0, second CA 1");
    expect(line).not.toContain(HOST);
    expect(readAcmeState(dir)).toMatchObject({ kind: "ok", value: { onFallback: true, issued: [0, 1] } });
  });

  it("is full with a retry time when both CAs are rate-limited", async () => {
    const { le, gts, clock, target, certs, run } = await setup(async () => EAB);
    le.mode = "limited";
    le.retryAfterSec = 7200;
    gts.mode = "limited";
    gts.retryAfterSec = 1800;
    certs.start();
    const start = clock.now();
    await run();
    expect(target.cert).toBeNull();
    expect(certs.snapshot()).toMatchObject({ valid: false, error: "full", fullUntil: start + 1800_000 });
    expect(clock.nextAt).toBe(start + 1800_000);
  });

  it("asks neither CA again before its own Retry-After when both are rate-limited", async () => {
    const { le, gts, clock, target, certs, run, settled } = await setup(async () => EAB);
    le.mode = "limited";
    le.retryAfterSec = 7200;
    gts.mode = "limited";
    gts.retryAfterSec = 1800;
    certs.start();
    await run();
    const asked = le.log.length;
    gts.mode = "ok";
    const done = settled();
    clock.advance(1800_000);
    await done;
    expect(le.log).toHaveLength(asked);
    expect(gts.log).toContain("issued");
    expect(target.cert).not.toBeNull();
  });

  it("leaves a rate-limited Let's Encrypt alone while the second CA fails another way", async () => {
    const { dir, le, gts, clock, certs, run, settled } = await setup(async () => EAB);
    le.mode = "limited";
    le.retryAfterSec = 7200;
    gts.mode = "reject";
    certs.start();
    const start = clock.now();
    await run();
    const asked = le.log.length;
    const second = gts.log.length;
    expect(clock.nextAt).toBe(start + 60_000);
    const done = settled();
    clock.advance(60_000);
    await done;
    expect(le.log).toHaveLength(asked);
    expect(gts.log.length).toBeGreaterThan(second);
    expect(readAcmeState(dir)).toMatchObject({ kind: "ok", value: { limitedUntil: { [le.directoryUrl]: start + 7_200_000 } } });
  });

  it("backs off 1 min, 10 min, 100 min while both CAs stay limited with no wait given", async () => {
    const { le, gts, clock, certs, run, settled } = await setup(async () => EAB);
    le.mode = "limited";
    le.retryAfterSec = 0;
    gts.mode = "limited";
    gts.retryAfterSec = 0;
    certs.start();
    await run();
    const gaps: number[] = [];
    for (let i = 0; i < 3; i++) {
      const next = clock.nextAt!;
      gaps.push(next - clock.now());
      expect(certs.snapshot()).toMatchObject({ error: "full", fullUntil: next });
      const done = settled();
      clock.advance(next - clock.now());
      await done;
    }
    expect(gaps).toEqual([60_000, 600_000, 6_000_000]);
  });

  it("is full when the relay has no second-CA keys left", async () => {
    const { le, gts, clock, certs, run } = await setup(async () => {
      throw new EabFullError(clock.now() + 600_000);
    });
    le.mode = "limited";
    certs.start();
    const start = clock.now();
    await run();
    expect(gts.log).toEqual([]);
    expect(certs.snapshot()).toMatchObject({ error: "full", fullUntil: start + 600_000 });
  });

  it("stays Let's Encrypt only when the relay offers no EAB key", async () => {
    const { le, gts, clock, certs, asked, run } = await setup(async () => null);
    le.mode = "limited";
    certs.start();
    await run();
    expect(asked).toHaveBeenCalledTimes(1);
    expect(gts.log).toEqual([]);
    expect(certs.snapshot()).toMatchObject({ valid: false, error: "certificate request failed: too many certificates", fullUntil: null });
    expect(clock.nextAt).toBe(clock.now() + le.retryAfterSec * 1000);
  });
});

describe("backoff after failures", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function manager(dir: string, acme: FakeAcme, clock: FakeClock, target = new Target()) {
    const events = new EventEmitter();
    const certs = new CertManager({
      dataDir: dir,
      host: HOST,
      directories: [acme.directoryUrl],
      accounts: {},
      clock,
      target,
      onChange: () => events.emit("change"),
      allowInsecureDirectories: true,
    });
    cleanups.push(() => certs.stop());
    const settled = () =>
      new Promise<void>((resolve) => {
        let started = false;
        const check = () => {
          if (certs.snapshot().issuing) started = true;
          if (!started || certs.snapshot().issuing) return;
          events.off("change", check);
          resolve();
        };
        events.on("change", check);
      });
    return { certs, settled };
  }

  async function failing(mode: FakeAcme["mode"]) {
    const { dir, cleanup } = tempDataDir();
    cleanups.push(cleanup);
    const acme = await FakeAcme.start({ ca: await TestCa.create() });
    cleanups.push(() => acme.close());
    acme.mode = mode;
    return { dir, acme, clock: new FakeClock() };
  }

  it("retries after 1 min, 10 min, 100 min, then once a day", async () => {
    const { dir, acme, clock } = await failing("reject");
    const { certs, settled } = await manager(dir, acme, clock);
    certs.start();
    let done = settled();
    certs.setConnected(true);
    await done;
    const gaps: number[] = [];
    for (let i = 0; i < 5; i++) {
      const next = clock.nextAt!;
      gaps.push(next - clock.now());
      done = settled();
      clock.advance(next - clock.now());
      await done;
    }
    expect(gaps).toEqual([60_000, 600_000, 6_000_000, DAY, DAY]);
    expect(acme.log.filter((entry) => entry === "new-order" || entry.startsWith("error:"))).toHaveLength(6);
    expect(certs.snapshot().error).toBe("certificate request failed: test rejects orders");
  });

  it("keeps the retry time across a restart instead of ordering again at once", async () => {
    const { dir, acme, clock } = await failing("reject");
    const first = await manager(dir, acme, clock);
    first.certs.start();
    let done = first.settled();
    first.certs.setConnected(true);
    await done;
    for (let i = 0; i < 3; i++) {
      done = first.settled();
      clock.advance(clock.nextAt! - clock.now());
      await done;
    }
    first.certs.stop();
    const asked = acme.log.length;
    const retryAt = clock.now() + DAY;
    const second = await manager(dir, acme, clock);
    second.certs.start();
    second.certs.setConnected(true);
    for (let next = clock.nextAt; next !== null && next < retryAt; next = clock.nextAt) clock.advance(next - clock.now());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(acme.log).toHaveLength(asked);
    clock.advance(retryAt - clock.now());
    await vi.waitFor(() => expect(second.certs.snapshot().issuing).toBe(false));
    expect(acme.log.length).toBeGreaterThan(asked);
  });

  it("waits out a rate limit's Retry-After when it is longer than the backoff", async () => {
    const { dir, acme, clock } = await failing("limited");
    acme.retryAfterSec = 7200;
    const { certs, settled } = await manager(dir, acme, clock);
    certs.start();
    const done = settled();
    certs.setConnected(true);
    await done;
    expect(clock.nextAt).toBe(clock.now() + 7_200_000);
  });

  /** A PC whose first certificate came from the second CA, Let's Encrypt being rate-limited. */
  async function onSecondCa() {
    const { dir, cleanup } = tempDataDir();
    cleanups.push(cleanup);
    const ca = await TestCa.create();
    const le = await FakeAcme.start({ ca });
    const gts = await FakeAcme.start({ ca, eab: { kid: "kid-gts", hmacKey: Buffer.alloc(32, 7).toString("base64url") } });
    cleanups.push(() => le.close(), () => gts.close());
    const clock = new FakeClock();
    const target = new Target();
    le.validator = directValidator(target, []);
    gts.validator = directValidator(target, []);
    le.mode = "limited";
    gts.validity = () => ({ notBefore: new Date(clock.now() - 60_000), notAfter: new Date(clock.now() + 3 * DAY) });
    const events = new EventEmitter();
    const certs = new CertManager({
      dataDir: dir,
      host: HOST,
      directories: [le.directoryUrl],
      accounts: {},
      fallback: { directory: gts.directoryUrl, externalAccount: async () => ({ kid: "kid-gts", hmacKey: Buffer.alloc(32, 7).toString("base64url") }) },
      clock,
      target,
      onChange: () => events.emit("change"),
      allowInsecureDirectories: true,
    });
    cleanups.push(() => certs.stop());
    certs.start();
    certs.setConnected(true);
    await vi.waitFor(() => expect(certs.snapshot()).toMatchObject({ issuing: false, valid: true }));
    return { dir, le, gts, clock, target, certs };
  }

  it("renews at the second CA once Let's Encrypt has rate-limited this PC", async () => {
    const { le, gts, clock, target, certs } = await onSecondCa();
    le.mode = "ok";
    for (let i = 0; i < 5 && target.installs.length < 2; i++) {
      clock.advance(RENEW_CHECK_MS);
      await vi.waitFor(() => expect(certs.snapshot().issuing).toBe(false));
    }
    expect(target.installs).toHaveLength(2);
    expect(le.log.filter((entry) => entry === "new-order" || entry === "error:rateLimited")).toEqual(["error:rateLimited"]);
    expect(gts.log.filter((entry) => entry === "issued")).toHaveLength(2);
  });

  it("renews at Let's Encrypt when the second CA is rate-limited, and stays there", async () => {
    const { dir, le, gts, clock, target, certs } = await onSecondCa();
    le.mode = "ok";
    gts.mode = "limited";
    for (let i = 0; i < 5 && target.installs.length < 2; i++) {
      clock.advance(RENEW_CHECK_MS);
      await vi.waitFor(() => expect(certs.snapshot().issuing).toBe(false));
    }
    expect(target.installs).toHaveLength(2);
    expect(le.log).toContain("issued");
    expect(gts.log.filter((entry) => entry === "issued")).toHaveLength(1);
    expect(certs.snapshot()).toMatchObject({ valid: true, error: null, fullUntil: null });
    expect(readAcmeState(dir)).toMatchObject({ kind: "ok", value: { onFallback: false, issued: [1, 1] } });
  });
});
