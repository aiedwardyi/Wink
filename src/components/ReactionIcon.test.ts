// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EXTENDED_REACTIONS } from "../../shared/reactions";

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return { ...actual, useStoreDispatch: () => () => undefined };
});

import { ReactionChips } from "./Reactions";
import type { Message } from "@/state/store";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
afterEach(() => act(() => root.render(null)));

const withMarks = (emojis: readonly string[]): Message => ({
  id: "m1", at: 1, role: "bot", kind: "text", text: "hi",
  reactions: emojis.map((emoji) => ({ emoji, by: "user" })),
});

function renderChips(emojis: readonly string[]) {
  act(() => root.render(createElement(ReactionChips, { threadId: "t", message: withMarks(emojis), corner: "left" })));
  return Array.from(host.querySelectorAll("[data-message-reactions] button"));
}

describe("reaction icons", () => {
  it("draws each offered emoji as an svg, not the text glyph", () => {
    const chips = renderChips(EXTENDED_REACTIONS);
    expect(chips).toHaveLength(EXTENDED_REACTIONS.length);
    for (const [i, chip] of chips.entries()) {
      expect(chip.querySelector("svg"), EXTENDED_REACTIONS[i]).not.toBeNull();
      expect(chip.textContent?.trim()).toBe("");
      expect(chip.querySelector("[data-emoji]")?.getAttribute("data-emoji")).toBe(EXTENDED_REACTIONS[i]);
    }
  });

  it("keeps the icon colors, never the text color", () => {
    const [chip] = renderChips(["👍"]);
    const svg = chip!.querySelector("svg")!.outerHTML;
    expect(svg).toMatch(/#[0-9a-f]{3,6}/i);
    expect(svg).not.toContain("currentColor");
  });

  it("draws the open-mouth face, not the hushed one", () => {
    const [chip] = renderChips(["😮"]);
    expect(chip!.querySelector("svg")!.outerHTML).toContain("face-with-open-mouth");
  });

  it("names each pill by its emoji for screen readers", () => {
    const chips = renderChips(["👍", "🎉"]);
    expect(chips.map((chip) => chip.getAttribute("aria-label"))).toEqual(["👍", "🎉"]);
  });

  it("puts a shown count in the pill name", () => {
    const message = { ...withMarks(["👍"]), reactions: [{ emoji: "👍", by: "user" }, { emoji: "👍", by: "helper" }] };
    act(() => root.render(createElement(ReactionChips, { threadId: "t", message, corner: "left" })));
    expect(host.querySelector("[data-message-reactions] button")?.getAttribute("aria-label")).toBe("👍 2");
  });

  it("keeps the text glyph for an older emoji with no icon", () => {
    const [chip] = renderChips(["💯"]);
    expect(chip!.querySelector("svg")).toBeNull();
    expect(chip!.textContent).toBe("💯");
  });
});
