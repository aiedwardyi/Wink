import { describe, expect, it } from "vitest";

import { factsOf } from "./about-you.ts";
import { CORPUS } from "./testing/import-secret-corpus.ts";

const runs = CORPUS.map(([, paste, secrets, keeps]) => ({ paste, ...factsOf(paste), secrets, keeps }));

describe("import secret filter corpus", () => {
  it("keeps every ordinary fact", () => {
    expect(runs.flatMap(({ facts, keeps }) => keeps.filter((keep) => !facts.includes(keep)))).toEqual([]);
  });

  it("leaves out every secret value", () => {
    // a passphrase of plain words reads like prose
    expect(runs.flatMap(({ facts, secrets }) => secrets.filter((secret) => facts.some((fact) => fact.includes(secret))))).toEqual(["correct horse battery staple"]);
  });

  it("counts a left-out line only when the paste had a secret", () => {
    expect(runs.filter(({ secrets, hidden }) => !secrets.length && hidden).map(({ paste }) => paste)).toEqual([]);
  });
});
