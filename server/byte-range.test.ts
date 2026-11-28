import { describe, expect, it } from "vitest";

import { byteRange } from "./byte-range.ts";

describe("byteRange", () => {
  it("returns all without a range", () => {
    expect(byteRange(undefined, 100)).toBe("all");
  });

  it("accepts suffix and open-ended ranges and clamps the end", () => {
    expect(byteRange("bytes=-50", 100)).toEqual({ start: 50, end: 99 });
    expect(byteRange("bytes=-150", 100)).toEqual({ start: 0, end: 99 });
    expect(byteRange("bytes=20-", 100)).toEqual({ start: 20, end: 99 });
    expect(byteRange("bytes=0-9999", 100)).toEqual({ start: 0, end: 99 });
  });

  it.each([
    ["bytes=0-0", 0],
    ["items=0-1", 100],
    ["bytes=", 100],
    ["bytes=-", 100],
    ["bytes=-0", 100],
    ["bytes=100-", 100],
    ["bytes=10-9", 100],
    ["bytes=0-1,3-4", 100],
    ["bytes=1.5-2", 100],
    ["bytes=+1-2", 100],
    [`bytes=-${"9".repeat(400)}`, 100],
    [`bytes=${"9".repeat(400)}-`, 100],
    [`bytes=0-${"9".repeat(400)}`, 100],
  ])("rejects %s for size %i", (header, size) => {
    expect(byteRange(header, size)).toBe("bad");
  });
});
