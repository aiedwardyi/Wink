import { describe, expect, it } from "vitest";

import type { Message } from "./store.ts";
import { TYPED_VALUES_HEADER, typedValueLines, typedValuesBlock, withoutTypedValues } from "./typed-values.ts";

const AT = new Date(2026, 10, 8, 12).getTime();
const DAY = 86_400_000;

let seq = 0;
const user = (text: string, patch: Partial<Message> = {}): Message => ({ id: `u${seq++}`, at: AT, role: "user", kind: "text", text, ...patch });
const bot = (text: string): Message => ({ id: `b${seq++}`, at: AT, role: "bot", kind: "text", text });
const linesOf = (...messages: Message[]) => typedValueLines(messages).map((entry) => entry.line);
const typedLines = (...texts: string[]) => linesOf(...texts.map((text) => user(text)));
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

describe("typed value lines", () => {
  it.each([
    ["a number of two or more digits", "we have 12 people coming"],
    ["a number with a unit", "aim for 40% margin"],
    ["a single digit with a unit", "it took 3 hours"],
    ["a Korean amount", "예산은 40000원"],
    ["money", "the budget is $1,200"],
    ["an ISO date", "launch on 2026-12-01"],
    ["a written date", "launch on Dec 3"],
    ["a Korean date", "12월 25일 출발"],
    ["a time", "call me at 3:30 pm"],
    ["a version", "ship version 1.0.247"],
    ["a numbered ref", "see #1224 first"],
    ["a code", "Codename for this chat: TIDE-4821"],
    ["an id mixing letters and digits", "the build id is a1b2c3d4e5"],
    ["an email", "mail me at pat@example.com"],
    ["a link", "docs at https://example.com/a/b"],
    ["a negative number", "temperature is -12 degrees"],
    ["a negative amount", "budget is -40000"],
    ["a Korean hour", "회의는 3시야"],
  ])("carries %s", (_name, text) => {
    expect(typedLines(text)).toEqual([`- 11-08 ${text}`]);
  });

  it.each([
    ["a single digit", "it is 7 now"],
    ["a file name or code name alone", "open notes.md and userTyping"],
    ["a numbered label", "Note 12: remember milk"],
    ["list numbering", "1. buy milk\n2) call Sam"],
    ["a fraction that is no date", "the ratio is 3/4 today"],
    ["plain words", "Our launch city is Busan"],
  ])("makes no line from %s", (_name, text) => {
    expect(typedLines(text)).toEqual([]);
  });

  it("drops the list mark and keeps the value behind it", () => {
    expect(typedLines("3. the budget is 40,000")).toEqual(["- 11-08 the budget is 40,000"]);
  });

  it("splits a message into sentences and keeps only those with a value", () => {
    expect(typedLines("Our launch city is Busan. The budget is 40,000. Tell nobody yet.")).toEqual(["- 11-08 The budget is 40,000."]);
  });

  it.each([
    ["a pasted block", "<pasted-text id=\"1\">budget 55555</pasted-text>"],
    ["pasted content", "<pasted_content>budget 55555</pasted_content>"],
    ["an attachment", "<attached-file name=\"budget-55555.pdf\" />"],
    ["a code fence", "```\nport 55555\n```"],
    ["a long quote", `he said "${"long words here ".repeat(6)}55555"`],
    ["a quoted reply line", "> the budget was 55555"],
    ["a long block", "the budget was 55555 ".repeat(25)],
    ["a log line", "2026-11-08 12:00 server started on 55555"],
    ["a shell line", "$ node run 55555"],
    ["a table row", "| total | 55555 |"],
    ["a compiler error", "error TS2345 at line 55555"],
    ["a code line", "const port = 55555"],
  ])("cuts %s as noise", (_name, noise) => {
    expect(typedLines(`${noise}\n\nthe real budget is 40,000`)).toEqual(["- 11-08 the real budget is 40,000"]);
  });

  it("cuts a sentence copied word for word from one of the 20 bot messages before it", () => {
    const said = "The total came to 48,250 after tax and fees.";
    expect(linesOf(bot(said), user(`${said}\nbut I only have 40,000`))).toEqual(["- 11-08 but I only have 40,000"]);
    const later = Array.from({ length: 20 }, (_, index) => bot(`reply ${index}`));
    expect(linesOf(bot(said), ...later, user(said))).toEqual([`- 11-08 ${said}`]);
  });

  it.each([
    ["a password", "my password is hunter2024"],
    ["a PIN", "my PIN is 4821"],
    ["a card number", "card number 4111 1111 1111 1111"],
    ["an account number", "account number 123456789"],
    ["a Korean password", "비밀번호는 482100"],
    ["a key-shaped string", "use sk-abcdefgh12345678 for 30 days"],
    ["a long mixed string", "the id is Zx9Kq2Lm8Vb4Nc7Tp1Rw5Yh3 from 2026-11-08"],
    ["a PIN on the line after its label", "My PIN:\n4821"],
    ["a PIN a paragraph after its label", "My PIN:\n\n4821"],
    ["a Korean password on the line after its label", "비밀번호:\n482100"],
    ["an account number on the line after its label", "Account number:\n123456789"],
    ["an API token in prose", "my API token is abc123def456"],
    ["a Korean API key in prose", "API 키는 abc123def456 입니다"],
  ])("never carries %s", (_name, secret) => {
    expect(typedLines(`${secret}\nthe budget is 40,000`)).toEqual(["- 11-08 the budget is 40,000"]);
  });

  it("keeps a whole sentence up to 100 chars and clips a longer one around its value", () => {
    const whole = `Our launch city is Busan, and the budget is 40,000 for ${"x".repeat(45)}`;
    expect(whole).toHaveLength(100);
    expect(typedLines(whole)).toEqual([`- 11-08 ${whole}`]);

    const long = "Our launch city is Busan and after a very long discussion with everyone on the team about what we can afford this quarter the budget is 40,000 and that is final for everybody involved in the plan";
    const [line] = typedLines(long);
    expect(line).toBe("- 11-08 …what we can afford this quarter the budget is 40,000 and that is final for…");
    const clip = line!.slice("- 11-08 …".length, -1);
    expect(clip.indexOf("40,000")).toBeLessThanOrEqual(50);
    expect(clip.length - clip.indexOf("40,000") - "40,000".length).toBeLessThanOrEqual(30);
  });

  it("clips far-apart values of one long sentence into separate lines", () => {
    const far = `The first number is 11111 and then ${"filler words go here ".repeat(8)}and the second number is 22222 at the very end of it`;
    expect(typedLines(far)).toEqual([
      "- 11-08 The first number is 11111 and then filler words go here…",
      "- 11-08 …filler words go here and the second number is 22222 at the very end of it",
    ]);
  });

  it("puts the day each line was typed in front, oldest first", () => {
    expect(linesOf(user("the budget is 40,000"), user("the venue holds 250 people", { at: AT + DAY }))).toEqual([
      "- 11-08 the budget is 40,000",
      "- 11-09 the venue holds 250 people",
    ]);
  });

  it("reads only what the user typed into the chat", () => {
    const text = "the budget is 40,000";
    expect(linesOf(
      bot(text),
      user(text, { from: { botId: "scout", name: "Scout", color: "blue" } }),
      user(text, { origin: "routine" }),
      user(text, { quick: { state: "asked" } }),
      user(text, { comm: { groupId: "g", withBotId: "b", withName: "B", withColor: "red" } }),
      user(text, { kind: "note" }),
    )).toEqual([]);
    const sent = user(text);
    expect(typedValueLines([sent], new Set([sent.id]))).toEqual([]);
  });

  it.each([
    ["launch on 2026-11-11", "date:2026-11-11"],
    ["merge PR-1230 first", "code:PR-1230"],
    ["ship v1.0.250 tonight", "version:1.0.250"],
    ["3시간 걸렸어", "amount:3시간|걸렸어"],
  ])("reads no sign or hour into %s", (text, key) => {
    expect(typedValueLines([user(text)]).map((entry) => [entry.line, entry.keys])).toEqual([[`- 11-08 ${text}`, [key]]]);
  });

  it("records where each line's message sits", () => {
    expect(typedValueLines([user("hello"), bot("hi"), user("the budget is 40,000")]).map((entry) => entry.index)).toEqual([2]);
  });
});

describe("typed values block", () => {
  const block = (maxBytes: number, ...texts: string[]) => typedValuesBlock(typedValueLines(texts.map((text) => user(text))), maxBytes);

  it("is empty for a chat with no typed values", () => {
    expect(block(12_000, "hello there", "Our launch city is Busan")).toBe("");
    expect(typedValuesBlock([], 12_000)).toBe("");
  });

  it("lists the lines under the header in time order", () => {
    expect(block(12_000, "Our launch city is Busan, and the budget is 40,000.", "Codename for this chat: TIDE-4821.")).toBe([
      TYPED_VALUES_HEADER,
      "- 11-08 Our launch city is Busan, and the budget is 40,000.",
      "- 11-08 Codename for this chat: TIDE-4821.",
    ].join("\n"));
  });

  it("keeps only the newest sentence of a value typed again", () => {
    expect(block(12_000, "the budget is 40,000", "the venue holds 250 people", "actually the budget is 40,000 total").split("\n").slice(1)).toEqual([
      "- 11-08 the venue holds 250 people",
      "- 11-08 actually the budget is 40,000 total",
    ]);
  });

  it("keeps the sign apart from the same digits", () => {
    expect(block(12_000, "the balance is 40000", "the balance is -40000").split("\n").slice(1)).toEqual([
      "- 11-08 the balance is 40000",
      "- 11-08 the balance is -40000",
    ]);
  });

  it("keeps a line while it still owns one of its values", () => {
    expect(block(12_000, "the budget is 40,000 for 250 people", "the budget is 40,000").split("\n").slice(1)).toEqual([
      "- 11-08 the budget is 40,000 for 250 people",
      "- 11-08 the budget is 40,000",
    ]);
  });

  it("treats a short number as a repeat only beside the same word", () => {
    expect(block(12_000, "we have 12 rooms", "we have 12 tickets", "we have 12 rooms booked").split("\n").slice(1)).toEqual([
      "- 11-08 we have 12 tickets",
      "- 11-08 we have 12 rooms booked",
    ]);
  });

  it("leaves a correction with a new value after the line it replaces", () => {
    expect(block(12_000, "the budget is 40,000", "the budget is 45,000 now").split("\n").slice(1)).toEqual([
      "- 11-08 the budget is 40,000",
      "- 11-08 the budget is 45,000 now",
    ]);
  });

  it("drops the oldest lines past the cap and says how many", () => {
    const texts = Array.from({ length: 30 }, (_, index) => `plant number ${10_000 + index} goes here`);
    const capped = block(600, ...texts);
    const rows = capped.split("\n");
    expect(bytes(capped)).toBeLessThanOrEqual(600);
    expect(rows[0]).toBe(TYPED_VALUES_HEADER);
    expect(rows[1]).toBe(`[${30 - (rows.length - 2)} older lines left out]`);
    expect(rows.at(-1)).toBe("- 11-08 plant number 10029 goes here");
    expect(rows.slice(2)).toEqual(texts.slice(-(rows.length - 2)).map((text) => `- 11-08 ${text}`));
    expect(bytes(block(600 + 40, ...texts))).toBeGreaterThan(bytes(capped));
  });

  it("is empty when not even the newest line fits", () => {
    expect(block(bytes(TYPED_VALUES_HEADER) + 10, "the budget is 40,000")).toBe("");
    expect(block(0, "the budget is 40,000")).toBe("");
    expect(block(-5, "the budget is 40,000")).toBe("");
  });

  it("gives the same bytes for the same rows", () => {
    const messages = [user("the budget is 40,000"), bot("noted"), user("Codename for this chat: TIDE-4821")];
    expect(typedValuesBlock(typedValueLines(messages), 12_000)).toBe(typedValuesBlock(typedValueLines(messages), 12_000));
  });
});

describe("withoutTypedValues", () => {
  it("returns the summary text without its block", () => {
    const values = typedValuesBlock(typedValueLines([user("the budget is 40,000")]), 12_000);
    expect(withoutTypedValues(`summary text\nsecond line\n\n${values}`)).toBe("summary text\nsecond line");
    expect(withoutTypedValues("summary text")).toBe("summary text");
  });
});
