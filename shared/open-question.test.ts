import { describe, expect, it } from "vitest";

import { isSentByPerson, scanQuestion } from "./open-question.ts";

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
});
