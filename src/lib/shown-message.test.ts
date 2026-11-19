import { describe, expect, it } from "vitest";

import { isShownMessage } from "./shown-message";

describe("isShownMessage", () => {
  it("hides only a bot's engine-summarized note", () => {
    expect(isShownMessage({ role: "bot", summarized: true })).toBe(false);
    expect(isShownMessage({ role: "bot" })).toBe(true);
    expect(isShownMessage({ role: "bot", summarized: false })).toBe(true);
    expect(isShownMessage({ role: "user", summarized: true })).toBe(true);
  });

  it("hides Wink's delivery copy of a held worker report", () => {
    expect(isShownMessage({ role: "bot", heldFrom: "n1" })).toBe(false);
  });
});
