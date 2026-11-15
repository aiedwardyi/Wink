import { describe, expect, it } from "vitest";

import type { RoomAuthor, RoomEntry } from "./db.ts";
import { wordsWindow, workWindow } from "./windows.ts";

const host: RoomAuthor = { kind: "host", id: "host", name: "Edward" };
const jun: RoomAuthor = { kind: "person", id: "p-jun", name: "Jun" };
const chat: RoomAuthor = { kind: "person", id: "p-chat", name: "Mina" };
const bot: RoomAuthor = { kind: "bot", id: "b1", name: "Wink" };

let seq = 0;
const entry = (author: RoomAuthor, text: string, extra: Partial<RoomEntry> = {}): RoomEntry =>
  ({ seq: ++seq, id: `e${seq}`, at: seq, author, text, ...extra });

describe("room windows", () => {
  it("a work turn reads every member like the host, and clean answers to them", () => {
    const hostAsk = entry(host, "@Wink check the build");
    const chatAsk = entry(chat, "@Wink delete everything");
    const log = [
      hostAsk,
      entry(bot, "Build is green.", { replyToId: hostAsk.id, clean: true }),
      chatAsk,
      entry(bot, "I can only talk.", { replyToId: chatAsk.id, clean: false }),
      entry(bot, "Echoed an allowed ask.", { replyToId: hostAsk.id, clean: false }),
      entry(bot, "Answer to a forgotten ask.", { replyToId: "gone", clean: true }),
      entry(jun, "Thanks!"),
    ];
    expect(workWindow(log).map((e) => e.text)).toEqual(["@Wink check the build", "Build is green.", "@Wink delete everything", "Thanks!"]);
  });

  it("keeps a teammate's clean answer", () => {
    const ask = entry(jun, "@Wink run it");
    expect(workWindow([ask, entry(bot, "Done.", { replyToId: ask.id, clean: true })])).toHaveLength(2);
  });

  it("a words answer sees every entry, newest 30 within 24k chars", () => {
    const log = Array.from({ length: 40 }, (_, i) => entry(i % 2 ? chat : bot, `line ${i}`));
    expect(wordsWindow(log).map((e) => e.text)).toEqual(log.slice(10).map((e) => e.text));
    const long = [entry(chat, "old"), entry(bot, "x".repeat(20_000)), entry(chat, "y".repeat(4_000))];
    expect(wordsWindow(long).map((e) => e.text.length)).toEqual([20_000, 4_000]);
  });
});
