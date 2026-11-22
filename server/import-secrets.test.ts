import { describe, expect, it } from "vitest";

import { factsOf } from "./about-you.ts";
import { CORPUS } from "./testing/import-secret-corpus.ts";

const LOST = ["WiFi: HomeNet-5G", "Tokens: 1500000", "My password is long and random.", "Password: none", "토큰: 8192"];
const runs = CORPUS.map(([, paste, secrets, keeps]) => ({ paste, ...factsOf(paste), secrets, keeps }));

describe("import secret filter corpus", () => {
  it("keeps every ordinary fact", () => {
    // a network name has a WiFi key's shape; the rest read as a value after their label, as before the filter
    expect(runs.flatMap(({ facts, keeps }) => keeps.filter((keep) => !facts.includes(keep)))).toEqual(LOST);
  });

  it("leaves out every secret value", () => {
    // a passphrase of plain words reads like prose; a value under a sub-heading of a secret section reads like one under any heading; "login" names no secret
    expect(runs.flatMap(({ facts, secrets }) => secrets.filter((secret) => facts.some((fact) => fact.includes(secret))))).toEqual(["lilac4023", "correct horse battery staple", "plum7010x"]);
  });

  it("counts a left-out line only when the paste had a secret", () => {
    expect(runs.filter(({ secrets, hidden }) => !secrets.length && hidden).map(({ paste }) => paste)).toEqual(LOST);
  });
});
