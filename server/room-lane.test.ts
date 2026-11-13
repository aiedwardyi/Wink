import { describe, expect, it } from "vitest";

import { createRoomLanes, laneKey } from "./room-lane.ts";

describe("room lanes", () => {
  it("gives each bot one lane and caps lanes across bots", () => {
    const lanes = createRoomLanes();
    expect(lanes.claim("a", "room-1")).toBe(true);
    expect(lanes.claim("a", "room-2")).toBe(false);
    expect(lanes.claim("b", "room-2")).toBe(true);
    expect(lanes.free("c")).toBe(false);
    expect(lanes.claim("c", "room-3")).toBe(false);
    lanes.release("a", "room-1");
    expect(lanes.thread("a")).toBeUndefined();
    expect(lanes.claim("c", "room-3")).toBe(true);
  });

  it("forgets a released lane so a later turn on its room is not a lane turn", () => {
    const lanes = createRoomLanes();
    lanes.claim("a", "room-1");
    lanes.release("a", "room-1");
    expect(lanes.thread("a")).toBeUndefined();
    expect(lanes.free("a")).toBe(true);
  });

  it("keeps a stopped lane until its thread's terminal event is handled", () => {
    const lanes = createRoomLanes();
    lanes.claim("a", "room-1");
    lanes.release("a", "room-1", true);
    expect(lanes.thread("a")).toBe("room-1");
    lanes.settle("room-2");
    expect(lanes.thread("a")).toBe("room-1");
    lanes.settle("room-1");
    expect(lanes.thread("a")).toBeUndefined();
  });

  it("frees a stopped lane whose terminal event came first", () => {
    const lanes = createRoomLanes();
    lanes.claim("a", "room-1");
    lanes.settle("room-1");
    lanes.release("a", "room-1", true);
    lanes.release("a", "room-1");
    expect(lanes.thread("a")).toBeUndefined();
  });

  it("keys a lane apart from its bot", () => {
    expect(laneKey("a")).not.toBe("a");
  });
});
