import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store-types";
import { callLength, callRows, callStripe, callSummary, STRIPE_BARS } from "./call-card";

const id = "c-0123456789ab";
const line = (n: number, role: "user" | "bot", text: string, at: number, extra: Partial<Message["call"]> = {}): Message =>
  ({ id: `l${n}`, role, kind: "text", text, at, call: { id, ...(role === "bot" ? { voice: true } : {}), ...extra } }) as Message;
const call = [
  line(1, "bot", "Good evening. What do you need?", 10_000),
  line(2, "user", "Can you fix the login page bug?", 16_000),
  line(3, "bot", "Fix the login page bug. Shall I send that?", 22_000),
  { id: "o", role: "user", kind: "text", text: "Fix the login page bug.", at: 25_000, call: { id, order: true } } as Message,
  line(4, "user", "Yes, send it.", 26_000),
];

describe("call card", () => {
  it("groups each call and keeps only the newest unsaved one live while on the call", () => {
    const typed = { id: "t", role: "user", kind: "text", text: "Thanks.", at: 30_000 } as Message;
    const { rows, live } = callRows([...call, typed], true);
    expect(rows.get(id)!.map((row) => row.id)).toEqual(["l1", "l2", "l3", "o", "l4"]);
    expect(live).toBe(id);
    expect(callRows(call, false).live).toBeUndefined();
    expect(callRows([{ ...call[0]!, call: { id, voice: true, ms: 151_000 } }, ...call.slice(1)], true).live).toBeUndefined();
  });

  it("formats the length as m:ss", () => {
    expect(callLength(151_000)).toBe("2:31");
    expect(callLength(4_400)).toBe("0:04");
  });

  it("shows the saved summary, else the person's first line", () => {
    expect(callSummary(call)).toBe("Can you fix the login page bug?");
    expect(callSummary([{ ...call[0]!, call: { id, voice: true, summary: "You asked Atlas to fix the login page bug." } }, ...call.slice(1)])).toBe("You asked Atlas to fix the login page bug.");
    expect(callSummary([call[0]!])).toBe("Good evening. What do you need?");
  });

  it("draws who talked when from line times only", () => {
    const bars = callStripe(call);
    expect(bars).toHaveLength(STRIPE_BARS);
    expect(bars[0]!.who).toBe("voice");
    expect(bars.at(-1)!.who).toBe("user");
    expect(bars.some((bar) => bar.who === null)).toBe(true);
    expect(bars.every((bar) => bar.height > 0 && bar.height <= 1)).toBe(true);
    expect(callStripe(call)).toEqual(bars);
    expect(callStripe([call[3]!])).toEqual([]);
  });
});
