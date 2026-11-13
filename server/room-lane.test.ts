import { describe, expect, it } from "vitest";

import { createRoomLanes, laneKey } from "./room-lane.ts";

describe("room lanes", () => {
  it("gives each bot one lane and caps lanes across bots", () => {
    const lanes = createRoomLanes(() => false);
    expect(lanes.claim("a", "room-1")).toBe(true);
    expect(lanes.claim("a", "room-2")).toBe(false);
    expect(lanes.claim("b", "room-2")).toBe(true);
    expect(lanes.free("c")).toBe(false);
    expect(lanes.claim("c", "room-3")).toBe(false);
    lanes.release("a", "room-1");
    expect(lanes.thread("a")).toBeUndefined();
    expect(lanes.claim("c", "room-3")).toBe(true);
  });

  it("holds a released lane while the driver still owns its thread", () => {
    const live = new Set(["room-1"]);
    const lanes = createRoomLanes((threadId) => live.has(threadId));
    lanes.claim("a", "room-1");
    lanes.release("a", "room-1");
    expect(lanes.thread("a")).toBe("room-1");
    expect(lanes.free("a")).toBe(false);
    live.delete("room-1");
    expect(lanes.free("a")).toBe(true);
  });

  it("keys a lane apart from its bot", () => {
    expect(laneKey("a")).not.toBe("a");
  });
});
