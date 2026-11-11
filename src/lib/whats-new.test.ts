import { describe, expect, it } from "vitest";

import { unseenRelease } from "./whats-new";

describe("unseen release notes", () => {
  it("shows the notes a skipped release carried", () => {
    expect(unseenRelease("1.0.247", "1.0.245")).toBe("1.0.246");
    expect(unseenRelease("1.0.248", "1.0.245", ["1.0.246"])).toBe("1.0.246");
  });

  it("shows them on an install with no record", () => {
    expect(unseenRelease("1.0.248", null, ["1.0.246"])).toBe("1.0.246");
  });

  it("shows nothing once they were seen, on this release or a later one without notes", () => {
    expect(unseenRelease("1.0.247", "1.0.246", ["1.0.246"])).toBeNull();
    expect(unseenRelease("1.0.248", "1.0.246", ["1.0.246"])).toBeNull();
    expect(unseenRelease("1.0.248", "1.0.247", ["1.0.246"])).toBeNull();
  });

  it("shows only the newest of two unseen", () => {
    expect(unseenRelease("1.0.249", "1.0.245", ["1.0.246", "1.0.248"])).toBe("1.0.248");
    expect(unseenRelease("1.0.249", "1.0.245", ["1.0.248", "1.0.246"])).toBe("1.0.248");
    expect(unseenRelease("1.0.249", "1.0.246", ["1.0.246", "1.0.248"])).toBe("1.0.248");
  });

  it("never shows notes newer than the running release", () => {
    expect(unseenRelease("1.0.248", "1.0.245", ["1.0.246", "1.0.250"])).toBe("1.0.246");
    expect(unseenRelease("1.0.245", null, ["1.0.246"])).toBeNull();
  });

  it("orders releases by number, not text", () => {
    expect(unseenRelease("1.0.100", "1.0.98", ["1.0.99", "1.0.100"])).toBe("1.0.100");
    expect(unseenRelease("1.1.0", "1.0.99", ["1.0.100"])).toBe("1.0.100");
  });
});
