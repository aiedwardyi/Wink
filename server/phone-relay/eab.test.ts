import { createPublicKey, verify } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { EabFullError, eabPayload, requestEab } from "./eab.ts";
import { readTicket } from "./store.ts";
import { loopbackLookup } from "./testing/fake-relay.ts";
import { BASE, rig, type Rig } from "./testing/harness.ts";

const NOW = 1_800_000_000_123;

describe("requestEab", () => {
  let r: Rig | null = null;
  afterEach(async () => {
    await r?.close();
    r = null;
  });

  async function ask(rr: Rig) {
    const ticket = readTicket(rr.dataDir);
    if (ticket.kind !== "ok") throw new Error("no ticket");
    return requestEab({ base: BASE, identity: rr.identity, ticket: ticket.value, now: NOW }, { ca: rr.ca.certPem, port: rr.relay.port, lookup: loopbackLookup });
  }

  it("is null when the relay offers no second CA", async () => {
    r = await rig();
    expect(await ask(r)).toBeNull();
  });

  it("signs ticket, key and time with the PC key and returns the key", async () => {
    r = await rig();
    r.relay.eabAnswer = () => ({ status: 200, body: JSON.stringify({ kid: "kid-1", hmacKey: "a".repeat(43) }) });
    expect(await ask(r)).toEqual({ kid: "kid-1", hmacKey: "a".repeat(43) });
    const body = JSON.parse(r.relay.eabBodies[0]!);
    expect(body.iat).toBe(Math.floor(NOW / 1000));
    expect(body.pk).toBe(r.identity.pk);
    const publicKey = createPublicKey(r.identity.privateKey);
    expect(verify(null, eabPayload(body.ticket, body.pk, body.iat), publicKey, Buffer.from(body.sig, "base64url"))).toBe(true);
  });

  it("turns full into a retry time and other refusals into the relay's code", async () => {
    r = await rig();
    const rr = r;
    rr.relay.eabAnswer = () => ({ status: 429, body: JSON.stringify({ error: "full", retryAfter: 600 }) });
    await expect(ask(rr)).rejects.toEqual(new EabFullError(NOW + 600_000));
    await expect(ask(rr).catch((error: EabFullError) => error.retryAt)).resolves.toBe(NOW + 600_000);
    rr.relay.eabAnswer = () => ({ status: 403, body: JSON.stringify({ error: "revoked" }) });
    await expect(ask(rr)).rejects.toThrow("relay refused a second-CA key (403 revoked)");
    rr.relay.eabAnswer = () => ({ status: 200, body: JSON.stringify({ kid: "", hmacKey: "x" }) });
    await expect(ask(rr)).rejects.toThrow("relay sent an unreadable second-CA key");
  });
});
