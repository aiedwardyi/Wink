import { describe, expect, it } from "vitest";
import { checkFixtureDates, fixtureDateHits } from "./check-fixture-dates.mjs";

const check = (source) => fixtureDateHits("src/lib/usage.test.ts", source);

describe("fixture lifecycle date gate", () => {
  it.each([
    'const reset = "2099-01-01T00:00:00Z";',
    'const window = { resetsAt: Date.parse("2099-01-01T00:00:00Z") };',
    'const token = { expires_at: "2099-01-01T00:00:00Z" };',
    'const cache = { fresh_until: "2099-01-01T00:00:00Z" };',
    'const reset = "2000-01-01T00:00:00Z";',
  ])("rejects pinned lifecycle dates independent of the current year: %s", (source) => {
    expect(check(source)).toHaveLength(1);
  });

  it("accepts resets derived from the fixture clock", () => {
    expect(check('const now = Date.parse("2000-01-01T00:00:00Z"); const window = { resetsAt: now + 60_000 };')).toEqual([]);
  });

  it("accepts a frozen clock in the same test", () => {
    expect(check('it("expiry", () => { vi.setSystemTime(new Date("2000-01-01")); const token = { expiresAt: "2000-01-02" }; });')).toEqual([]);
  });

  it("accepts a clock frozen by a suite hook", () => {
    expect(check('describe("tokens", () => { beforeEach(() => vi.setSystemTime(0)); it("expiry", () => { const token = { expiresAt: "2000-01-02" }; }); });')).toEqual([]);
  });

  it("does not let one test's frozen clock exempt another test", () => {
    expect(check('it("clock", () => { vi.setSystemTime(0); }); it("expiry", () => { const token = { expiresAt: "2099-01-02" }; });')).toHaveLength(1);
  });

  it("requires a deterministic frozen time", () => {
    expect(check('it("expiry", () => { vi.setSystemTime(Date.now()); const token = { expiresAt: "2099-01-02" }; });')).toHaveLength(1);
  });

  it("fails the gate for a new file and extra uses of an allowlisted date", () => {
    expect(checkFixtureDates(["src/lib/usage.test.ts"], () => 'const reset = "2099-01-01";')).toHaveLength(1);
    expect(checkFixtureDates(["server/claude-usage-probe.test.ts"], () => 'const windows = [{ resetsAt: "2026-11-04T00:00:00Z" }, { resetsAt: "2026-11-04T00:00:00Z" }, { resetsAt: "2026-11-04T00:00:00Z" }];')).toHaveLength(1);
  });

  it("ignores comments, historical metadata and protocol versions", () => {
    expect(check('// resetsAt: "2099-01-01"\nconst future = { protocolVersion: "2099-01-01" }; const data = { recordedAt: "2000-01-01" };')).toEqual([]);
  });

  it("accepts the repository with only its explicit base exceptions", () => {
    expect(checkFixtureDates()).toEqual([]);
  });
});
