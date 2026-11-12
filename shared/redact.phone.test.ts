import { describe, expect, it } from "vitest";

import { redactSecretsInText, StreamSecretMasker } from "./redact";

const body = "Ab_9-".repeat(8) + "XYZ";
const roomBody = "q7Zr2-Kx9_vLm4TnB8wYc1HdJ5sFgP3aQe6UoV0iRtN";
const tokens = [`wkp_${body}`, `wkd_${body}`, `wki_${roomBody}`, `wkg_${roomBody}`];

describe.each(tokens)("phone token %s", (token) => {
  it("masks a bare token", () => {
    expect(redactSecretsInText(`token is ${token}.`)).toBe(`token is «redacted 47 chars».`);
  });

  it("masks a token inside a pairing URL", () => {
    expect(redactSecretsInText(`open https://pc.ts.net/pair#k=${token}`)).toBe("open https://pc.ts.net/pair#k=«redacted 47 chars»");
  });

  it.each(Array.from({ length: token.length - 1 }, (_, i) => i + 1))("holds a token split at offset %i", (split) => {
    const masker = new StreamSecretMasker();
    expect(masker.push(`see ${token.slice(0, split)}`)).toBe("see ");
    expect(masker.push(token.slice(split))).toBe("");
    expect(masker.push(" done")).toBe("«redacted 47 chars» done");
    expect(masker.flush()).toBe("");
  });
});

it("masks the secret in a team room invite code", () => {
  expect(redactSecretsInText(`code: wkr1:pc.relay.example:inv-1.wki_${roomBody}`)).toBe("code: wkr1:pc.relay.example:inv-1.«redacted 47 chars»");
});
