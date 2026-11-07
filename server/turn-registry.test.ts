import { expect, it } from "vitest";
import { TurnRegistry } from "./turn-registry.ts";

it("binds a prepared user turn before its tools run", () => {
  const registry = new TurnRegistry();
  registry.prepare({ botId: "a", threadId: "t", owner: "user", depth: 0 });
  registry.started("one", "t");
  expect(registry.current("t")).toEqual({ turnId: "one", botId: "a", threadId: "t", owner: "user", depth: 0, rootId: null, userKeys: [], nowWatch: [] });
});

it("keeps a replacement turn when the previous turn settles late", () => {
  const registry = new TurnRegistry();
  registry.start("one", { botId: "a", threadId: "t", owner: "peer", depth: 1 });
  registry.start("two", { botId: "a", threadId: "t", owner: "room", depth: 1 });
  registry.settle("one");
  expect(registry.current("t")?.turnId).toBe("two");
  expect(registry.get("one")).toBeUndefined();
  registry.settle("two");
  expect(registry.current("t")).toBeUndefined();
});

it("cancels a failed start without registering a live turn", () => {
  const registry = new TurnRegistry();
  registry.prepare({ botId: "a", threadId: "t", owner: "peer", depth: 1 });
  registry.cancel("t");
  registry.started("one", "t");
  expect(registry.current("t")).toBeUndefined();
});
