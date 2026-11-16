import { describe, expect, it } from "vitest";

import { roomResponders } from "../../server/store.ts";

import { translate } from "./i18n";
import { roomLineSteers } from "./composer-busy";
import { groupComposerHint, groupResponseHint, roomRespondersForComposer } from "./group-routing";

describe("roomRespondersForComposer", () => {
  const members = [
    { id: "atlas", name: "Atlas" },
    { id: "milind", name: "Milind" },
  ];

  it("routes an unmentioned message to the configured lead", () => {
    expect(
      roomRespondersForComposer("hello there", members, { defaultResponder: { kind: "member", botId: "atlas" } }),
    ).toEqual([members[0]]);
  });

  it("lets explicit mentions override the configured lead", () => {
    expect(
      roomRespondersForComposer("@Milind take this", members, { defaultResponder: { kind: "member", botId: "atlas" } }),
    ).toEqual([members[1]]);
  });

  it("supports everyone and mentions-only room policies", () => {
    expect(roomRespondersForComposer("hello", members, { defaultResponder: { kind: "everyone" } })).toEqual(members);
    expect(roomRespondersForComposer("hello", members, { defaultResponder: { kind: "mentions" } })).toEqual([]);
    expect(roomRespondersForComposer("@everyone hello", members, { defaultResponder: { kind: "mentions" } })).toEqual(
      members,
    );
  });
});

describe("the composer routes a room line as the server does", () => {
  const members = [{ id: "scout", name: "Scout" }, { id: "pixel", name: "Pixel" }, { id: "ray", name: "Ray", hidden: true }];
  const botLine = (botId: string) => ({ from: { botId, name: botId, color: "teal" as const } });
  const teamLine = { ...botLine("tb-1"), author: { kind: "bot" as const, id: "tb-1", name: "tb-1", owner: "p-mina" } };
  const replies = [undefined, botLine("scout"), botLine("pixel"), botLine("ray"), teamLine, {}];
  const rules = [{ kind: "everyone" }, { kind: "mentions" }, { kind: "member", botId: "scout" }, { kind: "member", botId: "pixel" }] as const;
  const texts = ["why that one?", "@Pixel you?", "@everyone stop", "@Ray back?"];

  it("for every reply, rule and tag", () => {
    for (const replyTo of replies) for (const defaultResponder of rules) for (const text of texts) {
      const server = roomResponders(text, members, defaultResponder, replyTo).map((member) => member.id);
      const client = roomRespondersForComposer(text, members, { defaultResponder }, replyTo).map((member) => member.id);
      expect({ text, defaultResponder, replyTo, client }).toEqual({ text, defaultResponder, replyTo, client: server });
    }
  });

  it("steers a reply into the busy member only when it is to that member", () => {
    expect(roomLineSteers("why?", members, "scout", botLine("scout"))).toBe(true);
    for (const replyTo of [botLine("pixel"), botLine("ray"), teamLine]) expect(roomLineSteers("why?", members, "scout", replyTo)).toBe(false);
  });
});


describe("group chrome phrases", () => {
  const members = [
    { id: "atlas", name: "Atlas" },
    { id: "milind", name: "Milind" },
  ];
  const room = {
    name: "Launch",
    defaultResponder: { kind: "everyone" },
  } satisfies { name: string; defaultResponder: { kind: "everyone" } };

  it("returns complete Korean response hints, not English sentences", () => {
    const t = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) =>
      translate("ko", key, vars);
    expect(groupResponseHint(room, members, t)).toBe(translate("ko", "room.hint.everyone"));
    expect(groupResponseHint(room, members, t)).not.toMatch(/Everyone responds|@mention/i);
    const lead = { ...room, defaultResponder: { kind: "member" as const, botId: "atlas" } };
    expect(groupResponseHint(lead, members, t)).toBe("답변할 봇을 고르려면 @로 언급하세요.");
    expect(groupResponseHint(lead, members, t)).not.toMatch(/responds by default/i);
  });

  it("returns complete Korean composer placeholders without English fragments", () => {
    const t = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) =>
      translate("ko", key, vars);
    const everyone = groupComposerHint(room, members, t);
    expect(everyone).toBe(translate("ko", "composer.roomEveryone", { name: "Launch" }));
    expect(everyone).not.toMatch(/everyone responds|Message Launch/i);
    const lead = groupComposerHint({ ...room, defaultResponder: { kind: "member", botId: "atlas" } satisfies { kind: "member"; botId: string } }, members, t);
    expect(lead).toBe("Launch에게 메시지 보내기");
    expect(lead).toContain("Launch");
    expect(lead).not.toMatch(/Atlas responds/i);
  });

  it.each(["en", "ko"] as const)("keeps every group mode's placeholder the same in %s", (locale) => {
    const t = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate(locale, key, vars);
    const modes = [
      { ...room, dm: true },
      room,
      { ...room, defaultResponder: { kind: "mentions" as const } },
      { ...room, defaultResponder: { kind: "member" as const, botId: "atlas" } },
    ];
    for (const group of modes) {
      expect(groupComposerHint(group, members, t)).toBe(locale === "en" ? "Message Launch" : "Launch에게 메시지 보내기");
    }
  });
});
