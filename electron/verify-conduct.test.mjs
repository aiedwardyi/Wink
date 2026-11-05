import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { conduct, finalize, foldScore, scanScore, typed } from "./verify-conduct.mjs";
import * as reference from "../scripts/fixtures/verify/reference-conduct.mjs";

const fixture = JSON.parse(readFileSync(new URL("../scripts/fixtures/verify/muse-hidden.json", import.meta.url)));

describe("verify conductor", () => {
  it("preserves the recorded checker score apart from the desktop layout fold", () => {
    expect(reference.conduct(fixture)).toEqual(fixture.score);
    expect(conduct(fixture)).toEqual(foldScore(reference.conduct(fixture)));
    expect(scanScore(fixture)).toEqual(foldScore(reference.scanScore(fixture)));
    expect(typed("email")).toBe(reference.typed("email"));
  });

  it("preserves every scored observation and final issue spot", () => {
    const score = conduct(fixture);
    expect(score.hops.flatMap(h => h.src)).toEqual(fixture.score.hops.flatMap(h => h.src));
    expect(finalize(score, fixture.events)).toEqual(reference.finalize(fixture.score, fixture.events));
    expect(score.used).toEqual(["desktop", "phone"]);
    expect(Object.keys(score.tiles)).toEqual(["desktop", "phone"]);
    expect(score.layout).toEqual([{ t: 0, name: "fixed" }]);
    expect(score.inputs.every(i => i.tile === "desktop" || i.tile === null)).toBe(true);
    expect(score.inputs.map(i => i.t)).toEqual(score.inputs.map(i => i.t).sort((a, b) => a - b));
  });
});
