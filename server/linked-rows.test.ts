import { readFileSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { messageDatabase } from "./message-db.ts";
import { Store } from "./store.ts";

const selection = () => ({ instanceId: "claude", model: "opus" });
const picture = "C:\\Users\\me\\shots\\Screen shot_2.png";

function chat() {
  const setup = new Store(selection);
  const bot = setup.createBot({}, { seedMessages: false });
  for (let index = 0; index < 50; index++) setup.appendMessage(bot.threadId, { role: "bot", kind: "text", text: `step ${index}` });
  const link = setup.appendMessage(bot.threadId, { role: "bot", kind: "text", text: `Here: [shot](<${picture}>)` });
  return { threadId: bot.threadId, link };
}

// loaded per test, so the route check below runs on a checkout without linked-rows.ts
const rowsModule = () => import("./linked-rows.ts");

describe("linked file rows", () => {
  beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
  afterEach(() => vi.restoreAllMocks());

  it("reads only the rows naming the file and leaves the chat unloaded", async () => {
    const { linkedRows } = await rowsModule();
    const { threadId, link } = chat();
    const store = new Store(selection);
    const whole = vi.spyOn(store, "messagesFor");
    const rows = [...linkedRows(store)(threadId, picture)];
    expect(rows.map((row) => row.id)).toEqual([link.id]);
    expect(whole).not.toHaveBeenCalled();
    expect(store.loaded(threadId)).toBe(false);
  });

  it("answers again without a database read until the chat changes", async () => {
    const { linkedRows } = await rowsModule();
    const { threadId } = chat();
    const store = new Store(selection);
    const rows = linkedRows(store);
    expect([...rows(threadId, picture)]).toHaveLength(1);
    const prepare = vi.spyOn(messageDatabase(), "prepare");
    expect([...rows(threadId, picture)]).toHaveLength(1);
    expect(prepare).not.toHaveBeenCalled();
    prepare.mockRestore();
    const later = store.patchRow(threadId, store.activeLeaf(threadId)!, { text: `Again: [shot](<${picture}>)` })!;
    expect([...rows(threadId, picture)].map((row) => row.text)).toEqual([later.text]);
  });

  it("keeps a room's activity from dropping another chat's answers", async () => {
    const { linkedRows } = await rowsModule();
    const { threadId } = chat();
    const store = new Store(selection);
    const room = store.createGroup("Team", [store.createBot({}, { seedMessages: false }).id]);
    const rows = linkedRows(store);
    expect([...rows(threadId, picture)]).toHaveLength(1);
    store.patchGroup(room.id, { unread: true });
    const prepare = vi.spyOn(messageDatabase(), "prepare");
    expect([...rows(threadId, picture)]).toHaveLength(1);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("keeps only rows with link syntax", async () => {
    const { linkedRows } = await rowsModule();
    const { threadId, link } = chat();
    const setup = new Store(selection);
    for (let index = 0; index < 20; index++) setup.appendMessage(threadId, { role: "bot", kind: "text", text: `${index * 5}% complete` });
    expect([...linkedRows(new Store(selection))(threadId, picture)].map((row) => row.id)).toEqual([link.id]);
  });

  it("answers a different file in the same chat without another scan", async () => {
    const { linkedRows } = await rowsModule();
    const { threadId, link } = chat();
    const setup = new Store(selection);
    const other = setup.appendMessage(threadId, { role: "bot", kind: "text", text: "Also: [chart](</tmp/chart.png>)" });
    const store = new Store(selection);
    const rows = linkedRows(store);
    expect([...rows(threadId, picture)].map((row) => row.id)).toEqual([link.id, other.id]);
    const prepare = vi.spyOn(messageDatabase(), "prepare");
    expect([...rows(threadId, "/tmp/chart.png")].map((row) => row.id)).toContain(other.id);
    const added = store.appendMessage(threadId, { role: "bot", kind: "text", text: "New: [clip](</tmp/clip.mp4>)" });
    store.appendMessage(threadId, { role: "bot", kind: "text", text: "no link here" });
    expect([...rows(threadId, "/tmp/clip.mp4")].map((row) => row.id)).toContain(added.id);
    expect(prepare.mock.calls.some(([sql]) => sql.includes(" AS fromBotId"))).toBe(false);
  });

  it("reads a huge answer again instead of keeping it", async () => {
    const { linkedRows } = await rowsModule();
    const setup = new Store(selection);
    const { threadId } = setup.createBot({}, { seedMessages: false });
    setup.appendMessage(threadId, { role: "bot", kind: "text", text: `[shot](<${picture}>) ${"x".repeat(4_000_001)}` });
    const rows = linkedRows(new Store(selection));
    expect([...rows(threadId, picture)]).toHaveLength(1);
    const prepare = vi.spyOn(messageDatabase(), "prepare");
    expect([...rows(threadId, picture)]).toHaveLength(1);
    expect(prepare.mock.calls.some(([sql]) => sql.includes(" AS fromBotId"))).toBe(true);
  });

  it("keeps a link that escapes letters of the name", async () => {
    const { linkedRows } = await rowsModule();
    const setup = new Store(selection);
    const { threadId } = setup.createBot({}, { seedMessages: false });
    const link = setup.appendMessage(threadId, { role: "bot", kind: "text", text: "[doc](/tmp/report%2Epdf)" });
    expect([...linkedRows(new Store(selection))(threadId, "/tmp/report.pdf")].map((row) => row.id)).toEqual([link.id]);
  });

  it("keeps the full text of cold link rows containing NULs", async () => {
    const { linkedRows } = await rowsModule();
    const setup = new Store(selection);
    const { threadId } = setup.createBot({}, { seedMessages: false });
    setup.appendMessage(threadId, { role: "bot", kind: "text", text: "Log\0with no link" });
    const text = "Log\0tail\n\n[chart](</tmp/chart.png>)";
    const chart = setup.appendMessage(threadId, { role: "bot", kind: "text", text });
    const beforeNul = "<FILE:///tmp/table.png>\0tail";
    const table = setup.appendMessage(threadId, { role: "bot", kind: "text", text: beforeNul });
    const afterNul = "Log\0<FILE:///tmp/figure.png>";
    const figure = setup.appendMessage(threadId, { role: "bot", kind: "text", text: afterNul });
    const store = new Store(selection);
    expect([...linkedRows(store)(threadId, "/tmp/chart.png")]).toEqual([
      { id: chart.id, role: "bot", text },
      { id: table.id, role: "bot", text: beforeNul },
      { id: figure.id, role: "bot", text: afterNul },
    ]);
    expect(store.loaded(threadId)).toBe(false);
  });

  it("uses the loaded thread when there is one", async () => {
    const { linkedRows } = await rowsModule();
    const { threadId, link } = chat();
    const store = new Store(selection);
    store.messagesFor(threadId);
    expect([...linkedRows(store)(threadId, picture)].map((row) => row.id)).toContain(link.id);
  });

  function linkedFileRoute(source: string): string {
    const start = source.indexOf("/linked-(file(?:\\/.*)?|folder)$/");
    const end = source.indexOf("\n    m = path.match(", start);
    expect(start).toBeGreaterThan(0);
    expect(end - start).toBeGreaterThan(0);
    expect(end - start).toBeLessThan(1500);
    return source.slice(start, end);
  }

  it("the linked-file route never loads the whole thread", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const route = linkedFileRoute(source);
    expect(route).toContain("messages: (target) => linkedMessages(threadId, target)");
    expect(route).not.toMatch(/store\.(messagesFor|activePath)\(/);
  });

  it("checks for whole-thread reads inside the route's messages callback", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const callback = "messages: (target) => linkedMessages(threadId, target)";
    expect(source).toContain(callback);
    const mutated = source.replace(callback, "messages: () => store.messagesFor(threadId)");
    expect(linkedFileRoute(mutated)).toMatch(/store\.(messagesFor|activePath)\(/);
  });
});
