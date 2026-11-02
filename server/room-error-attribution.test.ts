import { describe, expect, it } from "vitest";

import type { Message } from "./store.ts";
import { stallErrorActivity } from "./room-error-attribution.ts";

const bot = { id: "b1", name: "Alice", color: "blue" };

// Mirrors the Retry gate in roomRetry (src/lib/room-retry.ts): an error
// activity only becomes a Retry candidate when it carries speaker
// attribution.
function wouldShowRetry(message: Omit<Message, "id" | "at">): boolean {
  if (message.kind !== "activity") return false;
  if (!message.tool?.name?.startsWith("error:")) return false;
  if (message.tool?.setup) return false;
  return Boolean(message.from?.botId);
}

describe("room retry attribution", () => {
  it("attributes the stall-watchdog error to the stalled speaker", () => {
    const activity = stallErrorActivity(bot, 20, true);
    expect(activity.tool?.name?.startsWith("error:")).toBe(true);
    expect(activity.from?.botId).toBe("b1");
    expect(wouldShowRetry(activity)).toBe(true);
  });

  it("leaves 1:1 errors unattributed so nothing changes outside rooms", () => {
    expect(stallErrorActivity(bot, 20, false).from).toBeUndefined();
    expect(wouldShowRetry(stallErrorActivity(bot, 20, false))).toBe(false);
  });

  it("leaves bot-null room errors unattributed as an intentional silent fallback", () => {
    expect(stallErrorActivity(null, 20, true).from).toBeUndefined();
  });

  it("adds only attribution, never duplicates or reorders", () => {
    const stall = stallErrorActivity(bot, 20, true);
    expect(stall.tool).toEqual({
      name: "error: no activity for 20 minutes — the turn was stopped",
      ok: false,
    });
    expect(stall.from).toEqual({ botId: "b1", name: "Alice", color: "blue" });
  });
});
