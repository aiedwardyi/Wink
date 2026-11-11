import { describe, expect, it } from "vitest";

import { roomResponder } from "./room-routing.ts";

const wink = { id: "b-wink", name: "Wink" };
const helper = { id: "b-helper", name: "위키" };
const bots = [wink, helper];

describe("roomResponder", () => {
  it("wakes the first @bot by position", () => {
    expect(roomResponder("hey @위키 and @Wink", bots, [])).toBe(helper);
    expect(roomResponder("@wink then @위키", bots, [])).toBe(wink);
  });

  it("routes Korean names typed decomposed or with a particle", () => {
    expect(roomResponder("@위키".normalize("NFD") + " 요약해 줘", bots, [])).toBe(helper);
    expect(roomResponder("@위키야 이거 봐 줘", bots, [])).toBe(helper);
  });

  it("wakes nobody for @everyone or a person's name", () => {
    expect(roomResponder("@everyone hello", bots, ["Mina"])).toBeNull();
    expect(roomResponder("@Mina can you look", bots, ["Mina"])).toBeNull();
    expect(roomResponder("@민아 봐 줘", bots, ["민아"])).toBeNull();
  });

  it("lets a longer person name win over a bot name it starts with", () => {
    expect(roomResponder("@Wink Kim hi", bots, ["Wink Kim"])).toBeNull();
    expect(roomResponder("@Mina hi @Wink", bots, ["Mina"])).toBe(wink);
  });

  it("falls back to the bot whose entry is replied to", () => {
    expect(roomResponder("thanks", bots, [], helper.id)).toBe(helper);
    expect(roomResponder("@Wink thanks", bots, [], helper.id)).toBe(wink);
    expect(roomResponder("thanks", bots, [])).toBeNull();
  });

  it("ignores an address glued to a word", () => {
    expect(roomResponder("mail me at user@Wink", bots, [])).toBeNull();
  });
});
