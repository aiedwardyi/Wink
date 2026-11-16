import { describe, expect, it } from "vitest";

import { pendingWakesFor, wakeTime, type Routine } from "./routines";

const routine = (patch: Partial<Routine>): Routine => ({
  id: "r", name: "Wake", prompt: "note", botId: "bot-1", runOn: "maus", enabled: true,
  schedule: { type: "once", at: 2 }, durationMinutes: 30, nextRunAt: 2, createdAt: 1, updatedAt: 1, ...patch,
});

describe("pendingWakesFor", () => {
  it("shows only this chat's pending wakes for its bots, soonest first", () => {
    const routines = [
      routine({ id: "later", wake: true, sourceThreadId: "chat", nextRunAt: 9 }),
      routine({ id: "soon", wake: true, sourceThreadId: "chat", nextRunAt: 5 }),
      routine({ id: "calendar", sourceThreadId: "chat" }),
      routine({ id: "rang", wake: true, sourceThreadId: "chat", nextRunAt: null }),
      routine({ id: "elsewhere", wake: true, sourceThreadId: "other" }),
      routine({ id: "peer", wake: true, sourceThreadId: "chat", botId: "bot-2" }),
    ];
    expect(pendingWakesFor(routines, ["bot-1"], "chat").map((wake) => wake.id)).toEqual(["soon", "later"]);
    expect(pendingWakesFor(routines, ["bot-1", "bot-2"], "chat").map((wake) => wake.id)).toEqual(["peer", "soon", "later"]);
  });
});

describe("wakeTime", () => {
  it("names the day only when the wake is not today", () => {
    const now = new Date(2026, 10, 14, 1, 0).getTime();
    expect(wakeTime(new Date(2026, 10, 14, 3, 45).getTime(), now, "en")).toBe("03:45");
    expect(wakeTime(new Date(2026, 10, 15, 3, 45).getTime(), now, "en")).toBe("Sun 03:45");
    expect(wakeTime(new Date(2026, 10, 21, 3, 45).getTime(), now, "en")).toBe("Sat 03:45");
  });
});
