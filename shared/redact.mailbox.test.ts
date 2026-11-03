import { describe, expect, it } from "vitest";

import { StreamSecretMasker } from "./redact";

const grant = `01b2c3d4.${"Ab_9-".repeat(8)}XYZ`;

describe("streaming mailbox grants", () => {
  it.each(Array.from({ length: grant.length - 1 }, (_, i) => i + 1))("holds a grant split at offset %i", (split) => {
    const masker = new StreamSecretMasker();
    expect(masker.push(`hello ${grant.slice(0, split)}`)).toBe("hello ");
    expect(masker.push(grant.slice(split))).toBe("");
    expect(masker.push("! next ")).toBe("«redacted 52 chars»! next ");
    expect(masker.flush()).toBe("");
  });

  it("holds one-character chunks and releases ordinary text as soon as a grant is ruled out", () => {
    const masker = new StreamSecretMasker();
    expect(masker.push("hello ")).toBe("hello ");
    for (const char of grant) expect(masker.push(char)).toBe("");
    expect(masker.flush()).toBe("«redacted 52 chars»");
    expect(masker.push("next a1b2c3d4.")).toBe("next ");
    expect(masker.push("!")).toBe("a1b2c3d4.!");
    expect(masker.push(" next 12345678")).toBe(" next ");
    expect(masker.push("9 ")).toBe("123456789 ");
    expect(masker.push(" next ab")).toBe(" next ");
    expect(masker.push("g.")).toBe("abg.");
    expect(masker.push(" next abc.")).toBe(" next abc.");
    expect(masker.push(`z${grant} `)).toBe(`z${grant} `);
    expect(masker.push(`${grant}Z!`)).toBe(`${grant}Z!`);
    expect(masker.flush()).toBe("");
  });
});
