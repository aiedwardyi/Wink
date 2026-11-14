import { describe, expect, it } from "vitest";

import { botChain, handsOff } from "./bot-chain.ts";

const rando = { id: "b-rando", name: "Rando" };
const star = { id: "tb-star", name: "스타줌" };
const bots = [rando, star];
const people = ["Edward", "JJ"];
const line = (kind: "host" | "person" | "bot", id: string, text: string) => ({ author: { kind, id }, text });

describe("handsOff", () => {
  it("holds for a bot line that @'s another bot only", () => {
    expect(handsOff(line("bot", rando.id, "@스타줌 what works for JJ?"), bots, people)).toBe(true);
    expect(handsOff(line("bot", star.id, "Done: Sat 7:30. @Edward @JJ"), bots, people)).toBe(false);
    expect(handsOff(line("bot", star.id, "@스타줌 note to self"), bots, people)).toBe(false);
    expect(handsOff(line("person", "p1", "@스타줌 hi"), bots, people)).toBe(false);
  });
});

describe("botChain", () => {
  it("counts bot lines since a person or the host spoke while the newest hands off", () => {
    const log = [
      line("person", "p1", "@Rando work with 스타줌"),
      line("bot", rando.id, "@스타줌 Edward is free after 6"),
      line("bot", star.id, "@Rando JJ is free after 7"),
    ];
    expect(botChain(log, bots, people)).toBe(2);
    expect(botChain([...log, line("bot", rando.id, "@스타줌 7:30 works")], bots, people)).toBe(3);
    expect(botChain([line("bot", rando.id, "@스타줌 hi"), line("host", "host", "hold on"), line("bot", rando.id, "@스타줌 again")], bots, people)).toBe(1);
  });

  it("is 0 once the newest line tags no bot or a person spoke", () => {
    expect(botChain([], bots, people)).toBe(0);
    expect(botChain([line("bot", rando.id, "@스타줌 hi"), line("bot", star.id, "Done. @Edward @JJ")], bots, people)).toBe(0);
    expect(botChain([line("bot", rando.id, "@스타줌 hi"), line("person", "p1", "thanks")], bots, people)).toBe(0);
  });
});
