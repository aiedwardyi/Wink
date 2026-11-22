import { describe, expect, it } from "vitest";

import { factsOf } from "./about-you.ts";
import { CORPUS } from "./testing/import-secret-corpus.ts";

// each line gives a secret word a value, and the import before this filter left each out too
const LOST = ["Tokens: 1500000", "My password is long and random.", "Password: none", "Card number ends in 4821.", "토큰: 8192", "Pin bowling high score is 214"];
// each value was saved before this filter too: no label names it ("login", "combo", "pass", "invite code"), it sits under a sub-heading, a network name's shape, or plain words
const SAVED = ["lilac4023", "correct horse battery staple", "plum7010x", "Sp4rrow-lake", "14-32-08", "maple-Tr33-99", "6021", "Qu1etRiver!", "tteok8899", "candle velvet mango", "8213821382", "2F3A9C8214", "01082158215", "ABCD8216", "plum821", "82A20#", "8221", "8231-ab12", "PineTree_903", "CloudNine2026", "Kestrel!742", "849-201-773", "xK9mPq2R", "4532-8910-4421-7709", "correct horse battery staple", "VelvetMoon#91", "VelvetMoon#91", "PineTree_903", "482910", "ABCD-9921", "4532 8910 4421 7709"];
const runs = CORPUS.map(([, paste, secrets, keeps]) => ({ paste, ...factsOf(paste), secrets, keeps }));

describe("import secret filter corpus", () => {
  it("keeps every ordinary fact", () => {
    expect(runs.flatMap(({ facts, keeps }) => keeps.filter((keep) => !facts.includes(keep)))).toEqual(LOST);
  });

  it("leaves out every secret value", () => {
    expect(runs.flatMap(({ facts, secrets }) => secrets.filter((secret) => facts.some((fact) => fact.includes(secret))))).toEqual(SAVED);
  });

  it("counts a left-out line only when the paste had a secret", () => {
    expect(runs.filter(({ secrets, hidden }) => !secrets.length && hidden).map(({ paste }) => paste)).toEqual(LOST);
  });
});
