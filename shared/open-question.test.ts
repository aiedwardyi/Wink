import { describe, expect, it } from "vitest";

import { answerText, isSentByPerson, scanQuestion, typedReply } from "./open-question.ts";

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

describe("a question settled with the person's line", () => {
  const folder = { role: "bot", kind: "options", card: { askUser: true as const, subtitle: "Which folder?", staysOpen: true as const } };
  const branch = (card: object) => ({ role: "bot", kind: "options", card: { askUser: true as const, subtitle: "Which branch?", staysOpen: true as const, ...card } });
  const line = (text: string) => ({ role: "user", kind: "text", text });

  it("takes that line, so an older question stays open", () => {
    expect(scanQuestion([folder, branch({}), line("main")])).toBe(folder);
    expect(scanQuestion([folder, branch({ answered: "main" }), line("main")])).toBe(folder);
    expect(scanQuestion([folder, branch({ options: ["main", "dev"], answered: "Answered in chat" }), line("release")])).toBe(folder);
  });

  it("a tapped line answers its own card, even after a newer one arrived", () => {
    const ship = { id: "ship", role: "bot", kind: "options", card: { askUser: true as const, subtitle: "Ship it?", staysOpen: true as const, options: ["Yes", "No"] } };
    const tap = { ...line("Yes"), answersCard: "ship" };
    expect(scanQuestion([ship, branch({}), tap])?.card.subtitle).toBe("Which branch?");
    expect(scanQuestion([{ ...ship, card: { ...ship.card, answered: "Yes" } }, branch({}), tap])?.card.subtitle).toBe("Which branch?");
  });

  it("leaves the next line to the older question", () => {
    expect(scanQuestion([folder, branch({ answered: "main" }), line("main"), line("docs")])).toBeNull();
    expect(scanQuestion([folder, branch({ dismissed: true }), line("docs")])).toBeNull();
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


describe("a typed line on an open question", () => {
  const card = (options: string[]) => ({ role: "bot", kind: "options", card: { askUser: true as const, subtitle: "Ship it?", staysOpen: true as const, options } });

  it("answers a card without choices or with a choice's text, and never one it only types past", () => {
    expect(typedReply(card([]), "after lunch\nthanks")).toBe("after lunch");
    expect(typedReply(card(["Yes", "No"]), " Yes ")).toBe("Yes");
    expect(typedReply(card(["Yes", "No"]), "is this the review thing?")).toBeNull();
  });
});
