import { describe, expect, it } from "vitest";

import { redactSecretsInText, StreamSecretMasker } from "./redact";

const body = "Ab_9-".repeat(8) + "XYZ";
const tokens = [`wkp_${body}`, `wkd_${body}`];

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
