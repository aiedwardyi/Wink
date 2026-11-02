import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { overlappingPaths, packShards, timingsFromReports } from "./vitest-shards.mjs";

const timings = JSON.parse(readFileSync(new URL("./vitest-timings.json", import.meta.url), "utf8"));

describe("packShards", () => {
  it("puts every file in exactly one shard", () => {
    const files = [...Object.keys(timings), "server/new-file.test.ts"];
    const packed = packShards(files, timings, 4).flatMap((shard) => shard.files);
    expect(packed.toSorted()).toEqual(files.toSorted());
  });

  it("balances the committed timings within a few seconds", () => {
    const seconds = packShards(Object.keys(timings), timings, 4).map((shard) => shard.seconds);
    expect(Math.max(...seconds) - Math.min(...seconds)).toBeLessThan(5);
  });

  it("costs an untimed file at the median", () => {
    const [shard] = packShards(["a", "b", "c", "new"], { a: 1, b: 2, c: 9 }, 1);
    expect(shard.seconds).toBe(14);
  });

  it("packs the same way whatever order the files arrive in", () => {
    const files = Object.keys(timings);
    expect(packShards(files.toReversed(), timings, 4)).toEqual(packShards(files, timings, 4));
  });

  it("refuses a shard that would get no files", () => {
    expect(() => packShards(["a", "b"], {}, 3)).toThrow(/empty shard/);
  });
});

describe("overlappingPaths", () => {
  it("flags a path that a longer path contains", () => {
    expect(overlappingPaths(["server/a.test.ts", "companion/server/a.test.ts", "src/b.test.ts"])).toEqual([
      "server/a.test.ts in companion/server/a.test.ts",
    ]);
  });

  it("finds none in the committed timings", () => {
    expect(overlappingPaths(Object.keys(timings))).toEqual([]);
  });
});

describe("timingsFromReports", () => {
  it("strips the checkout root and spreads untracked wall time per file", () => {
    const report = {
      startTime: 0,
      testResults: [
        { name: "D:\\a\\Wink\\Wink\\server\\a.test.ts", startTime: 1000, endTime: 3000 },
        { name: "D:\\a\\Wink\\Wink\\src\\b.test.ts", startTime: 4000, endTime: 5000 },
      ],
    };
    expect(timingsFromReports([report])).toEqual({ "server/a.test.ts": 3, "src/b.test.ts": 2 });
  });
});
