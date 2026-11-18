import { describe, expect, it } from "vitest";

import { ANSWERED_IN_CHAT, answerText, isSentByPerson, scanQuestion } from "./open-question.ts";

const ask = { role: "bot", kind: "options", card: { askUser: true as const } };

describe("team room rows and open questions", () => {
  it("a teammate's line never closes the host's question", () => {
    const person = { role: "user", kind: "text", author: { kind: "person" } };
    expect(isSentByPerson(person)).toBe(false);
    expect(scanQuestion([ask, person])).toBe(ask);
  });

  it("the host's own room line still closes it", () => {
    const host = { role: "user", kind: "text", author: { kind: "host" } };
    expect(isSentByPerson(host)).toBe(true);
    expect(scanQuestion([ask, host])).toBeNull();
  });

  it("a call transcript line never closes it, a spoken answer sent to the bot does", () => {
    const line = { role: "user", kind: "text", call: { id: "c-0123456789ab" } };
    const answer = { role: "user", kind: "text", call: { id: "c-0123456789ab", ask: true as const } };
    expect(scanQuestion([ask, line])).toBe(ask);
    expect(scanQuestion([ask, line, answer])).toBeNull();
  });
});

describe("an answer to an older question", () => {
  it("names its question only when a newer question follows", () => {
    const older = { role: "bot", kind: "options", card: { askUser: true as const, subtitle: "Ship\n it?", staysOpen: true as const } };
    const newer = { role: "bot", kind: "options", card: { askUser: true as const, subtitle: "Which branch?", staysOpen: true as const } };
    expect(answerText([older, newer], older, "Yes")).toBe("Re: “Ship it?”\nYes");
    expect(answerText([older, newer], newer, "main")).toBe("main");
  });
});

describe("a settled card", () => {
  it("never hands a line typed past it to an older question", () => {
    const folder = { role: "bot", kind: "options", card: { askUser: true as const, subtitle: "Which folder?", staysOpen: true as const } };
    const branch = { role: "bot", kind: "options", card: { askUser: true as const, subtitle: "Which branch?", staysOpen: true as const, options: ["main", "dev"] } };
    const said = (text: string) => ({ role: "user", kind: "text", text });
    expect(scanQuestion([folder, branch, said("release")])).toBe(branch);
    expect(scanQuestion([folder, { ...branch, card: { ...branch.card, answered: ANSWERED_IN_CHAT } }, said("release")])).toBe(folder);
    const tapped = { ...branch, card: { ...branch.card, answered: "main" } };
    expect(scanQuestion([folder, tapped, said("release"), said("main")])).toBe(folder);
    expect(scanQuestion([folder, tapped, said("main"), said("src/app")])).toBeNull();
  });
});

