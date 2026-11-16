import { describe, expect, it } from "vitest";

import { isShownMessage } from "./shown-message";

describe("isShownMessage", () => {
  it("hides only a bot's engine-summarized note", () => {
    expect(isShownMessage({ role: "bot", summarized: true })).toBe(false);
    expect(isShownMessage({ role: "bot" })).toBe(true);
    expect(isShownMessage({ role: "bot", summarized: false })).toBe(true);
    expect(isShownMessage({ role: "user", summarized: true })).toBe(true);
  });

  it("hides a tapped choice's line; its card shows the answer", () => {
    expect(isShownMessage({ role: "user", answersCard: "ask" })).toBe(false);
    expect(isShownMessage({ role: "user" })).toBe(true);
    expect(isShownMessage({ role: "bot", answersCard: "ask" })).toBe(true);
  });
});
