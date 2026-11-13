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

  it("never falls back to a host reply target when a teammate's bot is tagged", () => {
    expect(roomResponder("@스타줌 이거해.", [wink], [], wink.id, true, ["스타줌"])).toBeNull();
    expect(roomResponder("@스타줌".normalize("NFD") + "아 이거해.", bots, [], wink.id, true, ["스타줌"])).toBeNull();
    expect(roomResponder("@스타줌 이거해. @위키 review", bots, [], wink.id, true, ["스타줌"])).toBe(helper);
    expect(roomResponder("@스타줌 Kim hi", bots, ["스타줌 Kim"], wink.id, true, ["스타줌"])).toBe(wink);
  });

  it("keeps reply fallback for people tags, everyone and untagged lines", () => {
    expect(roomResponder("@Mina can you look", bots, ["Mina"], wink.id)).toBe(wink);
    expect(roomResponder("@everyone hello", bots, [], wink.id)).toBe(wink);
    expect(roomResponder("thanks", [wink], [], wink.id, true, ["스타줌"])).toBe(wink);
    expect(roomResponder("thanks", [wink], [], undefined, true, ["스타줌"])).toBe(wink);
  });

  it("ignores an address glued to a word", () => {
    expect(roomResponder("mail me at user@Wink", bots, [])).toBeNull();
  });
});
