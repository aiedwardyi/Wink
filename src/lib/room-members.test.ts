import { describe, expect, it } from "vitest";

import { roomResponders } from "../../server/store.ts";
import { translate } from "./i18n";
import { answerOrderKey, answerOrderVars, moveMember, nextMemberIds } from "./room-members";

const pick = (...ids: string[]) => new Set(ids);

describe("nextMemberIds", () => {
  it("keeps the existing roster in place so the room's lead does not move", () => {
    expect(nextMemberIds(["lead", "second"], pick("lead", "second"), ["second", "lead"])).toEqual(["lead", "second"]);
  });

  it("appends newly ticked bots after the members already in the room", () => {
    expect(nextMemberIds(["lead"], pick("lead", "scout", "archivist"), ["archivist", "lead", "scout"])).toEqual([
      "lead",
      "archivist",
      "scout",
    ]);
  });

  it("drops members that were unticked", () => {
    expect(nextMemberIds(["lead", "second"], pick("second"), ["lead", "second"])).toEqual(["second"]);
  });

  it("ignores ticked ids that are not offered in the list", () => {
    expect(nextMemberIds(["lead"], pick("lead", "ghost"), ["lead"])).toEqual(["lead"]);
  });

  it("returns nothing when every member is unticked", () => {
    expect(nextMemberIds(["lead"], pick(), ["lead"])).toEqual([]);
  });
});

describe("moveMember", () => {
  it("moves a member to a new place and shifts the rest", () => {
    expect(moveMember(["wink", "pokkey", "career"], "career", 0)).toEqual(["career", "wink", "pokkey"]);
    expect(moveMember(["wink", "pokkey", "career"], "wink", 1)).toEqual(["pokkey", "wink", "career"]);
  });

  it("clamps past either end and ignores ids not in the roster", () => {
    expect(moveMember(["wink", "pokkey"], "wink", 9)).toEqual(["pokkey", "wink"]);
    expect(moveMember(["wink", "pokkey"], "pokkey", -1)).toEqual(["pokkey", "wink"]);
    expect(moveMember(["wink", "pokkey"], "ghost", 0)).toEqual(["wink", "pokkey"]);
  });

  it("makes the next Everyone turn answer in the new order", () => {
    const bots = [{ id: "wink", name: "Wink" }, { id: "pokkey", name: "Pokkey" }, { id: "career", name: "Career" }];
    const memberIds = moveMember(bots.map((b) => b.id), "career", 0);
    const members = memberIds.map((id) => bots.find((b) => b.id === id)!);
    expect(roomResponders("hi all", members, { kind: "everyone" }).map((b) => b.name)).toEqual(["Career", "Wink", "Pokkey"]);
  });
});

describe("answerOrderKey", () => {
  const label = (locale: "en" | "ko", n: number) => translate(locale, answerOrderKey(n), answerOrderVars(locale, n));

  it("says 1st, 2nd, 3rd in English", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23].map((n) => label("en", n))).toEqual([
      "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd",
    ]);
  });

  it("counts in native Korean words up to a full 100-bot group", () => {
    expect([1, 2, 3, 4, 10, 11, 12, 20, 21, 35, 99, 100, 101].map((n) => label("ko", n))).toEqual([
      "첫 번째", "두 번째", "세 번째", "네 번째", "열 번째", "열한 번째", "열두 번째", "스무 번째", "스물한 번째", "서른다섯 번째", "아흔아홉 번째", "백 번째", "101 번째",
    ]);
  });
});
