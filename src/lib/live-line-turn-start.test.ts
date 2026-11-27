import { describe, expect, it } from "vitest";
import { liveTurnSteps } from "./activity-runs";
import type { Message } from "@/state/store";

const row = (id: string, at: number, extra: Partial<Message>): Message => ({ id, at, text: id, ...extra } as Message);

describe("live line must not take the last turn's answer", () => {
  it("send not yet echoed (optimistic placeholder row)", () => {
    const list = [
      row("u1", 1, { role: "user", kind: "text" }),
      row("s1", 2, { role: "bot", kind: "text", step: true }),
      row("a1", 3, { role: "bot", kind: "text" }),
      row("u2", 4, { role: "user", kind: "text", placeholder: true }),
    ];
    const live = liveTurnSteps(list, null, true);
    expect({ hidden: [...live.hiddenIds], line: live.fallbackText }).toEqual({ hidden: [], line: null });
  });
  it("turn woken by a worker note (role bot, kind note), no new user line", () => {
    const list = [
      row("u1", 1, { role: "user", kind: "text" }),
      row("s1", 2, { role: "bot", kind: "text", step: true }),
      row("a1", 3, { role: "bot", kind: "text" }),
      row("n1", 4, { role: "bot", kind: "note" }),
    ];
    const live = liveTurnSteps(list, null, true);
    expect({ hidden: [...live.hiddenIds], line: live.fallbackText }).toEqual({ hidden: [], line: null });
  });
  it("a sidekick question mid-turn keeps the running turn's progress in the live line", () => {
    const list = [
      row("u1", 1, { role: "user", kind: "text" }),
      row("t1", 2, { role: "bot", kind: "text" }),
      row("q1", 3, { role: "user", kind: "text", quick: { state: "asked" } }),
      row("qa1", 4, { role: "bot", kind: "text", quick: { state: "answer", askId: "q1" } }),
    ];
    const live = liveTurnSteps(list, null, true);
    expect({ hidden: [...live.hiddenIds], line: live.fallbackText }).toEqual({ hidden: ["t1"], line: "t1" });
  });
  it("a note or send that lands after the wait began steers the running turn", () => {
    const list = [
      row("u1", 1, { role: "user", kind: "text" }),
      row("t1", 2, { role: "bot", kind: "text" }),
      row("n1", 3, { role: "bot", kind: "note" }),
      row("t2", 4, { role: "bot", kind: "text" }),
      row("u2", 5, { role: "user", kind: "text", placeholder: true }),
    ];
    const live = liveTurnSteps(list, null, true, { id: "u1", settled: true });
    expect({ hidden: [...live.hiddenIds], line: live.fallbackText }).toEqual({ hidden: ["t1", "t2"], line: "t2" });
  });
  it("a note that landed mid-turn wakes a turn after it: the answer just given and its steps stay", () => {
    const list = [
      row("u1", 1, { role: "user", kind: "text" }),
      row("s1", 2, { role: "bot", kind: "text", step: true }),
      row("n1", 3, { role: "bot", kind: "note" }),
      row("s2", 4, { role: "bot", kind: "text", step: true }),
      row("a1", 5, { role: "bot", kind: "text" }),
    ];
    const live = liveTurnSteps(list, null, true, { id: "a1", settled: true });
    expect({ hidden: [...live.hiddenIds], line: live.fallbackText }).toEqual({ hidden: [], line: null });
    const woke = liveTurnSteps([...list, row("t1", 6, { role: "bot", kind: "text" })], null, true, { id: "a1", settled: true });
    expect({ hidden: [...woke.hiddenIds], line: woke.fallbackText }).toEqual({ hidden: ["t1"], line: "t1" });
  });
  it("a second note during a note-woken turn wakes the next one: that answer stays", () => {
    const list = [
      row("u1", 1, { role: "user", kind: "text" }),
      row("a0", 2, { role: "bot", kind: "text" }),
      row("n1", 3, { role: "bot", kind: "note" }),
      row("s1", 4, { role: "bot", kind: "text", step: true }),
      row("n2", 5, { role: "bot", kind: "note" }),
      row("a1", 6, { role: "bot", kind: "text" }),
    ];
    const live = liveTurnSteps(list, null, true, { id: "a1", settled: true });
    expect({ hidden: [...live.hiddenIds], line: live.fallbackText }).toEqual({ hidden: [], line: null });
  });
});
