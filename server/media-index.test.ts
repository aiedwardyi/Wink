import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { buildMediaIndex, createMediaIndex } from "./media-index.ts";
import { closeMessageDb, replaceThread } from "./message-db.ts";
import { Store, type Message } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const HOUR = 3_600_000;
const START = Date.UTC(2026, 0, 1);
const shot = (n: number): Message => ({ id: `m${n}`, at: START + n * HOUR, role: "bot", kind: "text", text: `[shot-${n}.png](C:\\w\\shot-${n}.png)` });
const upload = 'see\n<attached-image path="C:\\att\\abc-1.png" />\n<attached-file path="C:\\att\\notes.docx" name="notes.docx" size="2048" />';

describe("media index", () => {
  beforeEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
  });

  it("lists a whole chat in one answer, newest first, each file once", () => {
    const path: Message[] = [
      { id: "u1", at: START - HOUR, role: "user", kind: "text", text: upload },
      ...Array.from({ length: 5_000 }, (_, n) => shot(n)),
      { id: "b1", at: START + 5_000 * HOUR, role: "bot", kind: "text", text: "Again: [shot-0.png](C:\\w\\shot-0.png), ![chart](https://example.com/chart.png) and [report.pdf](C:\\w\\report.pdf)" },
      { id: "b2", at: START + 5_001 * HOUR, role: "bot", kind: "text", text: "[gone.png](C:\\w\\gone.png)", summarized: true },
    ];

    const index = buildMediaIndex("t1", path.toReversed());

    expect(index.ids).toHaveLength(5_004);
    expect(index.ids.slice(0, 4)).toEqual(["b1", "b1", "b1", "m4999"]);
    expect(index.kind.slice(0, 4)).toBe("ulll");
    expect(index.name.slice(0, 4)).toEqual(["chart.png", "shot-0.png", "report.pdf", "shot-4999.png"]);
    expect(index.ref.slice(0, 4)).toEqual(["https://example.com/chart.png","C:\\w\\shot-0.png", "C:\\w\\report.pdf", "C:\\w\\shot-4999.png"]);
    expect(index.at[3]).toBe((START + 4_999 * HOUR) / 1000);
    expect(index.ids.slice(-3)).toEqual(["m1", "u1", "u1"]);
    expect(index.kind.slice(-2)).toBe("af");
    expect(index.name.slice(-2)).toEqual(["abc-1.png", "notes.docx"]);
    expect(index.ref.slice(-2)).toEqual(["", "C:\\att\\notes.docx"]);
  });

  it("answers again only when a file lands, and with the version alone when nothing changed", () => {
    const store = new Store(selection);
    const { threadId } = store.createBot({}, { seedMessages: false });
    store.appendMessage(threadId, { role: "bot", kind: "text", text: "[a.png](C:\\w\\a.png)" });
    const { list: media } = createMediaIndex(store);

    const first = media(threadId);
    expect("ids" in first && first.ids).toHaveLength(1);
    expect(media(threadId, first.v)).toEqual({ v: first.v });

    store.appendMessage(threadId, { role: "user", kind: "text", text: "thanks" });
    expect(media(threadId, first.v)).toEqual({ v: first.v });

    store.appendMessage(threadId, { role: "bot", kind: "text", text: "[b.pdf](C:\\w\\b.pdf)" });
    const next = media(threadId, first.v);
    expect(next.v).not.toBe(first.v);
    expect("name" in next && next.name).toEqual(["b.pdf", "a.png"]);
  });

  it("follows a streamed reply and a branch switch", () => {
    const store = new Store(selection);
    const { threadId } = store.createBot({}, { seedMessages: false });
    const ask = store.appendMessage(threadId, { role: "user", kind: "text", text: "draw it" });
    const reply = store.appendMessage(threadId, { role: "bot", kind: "text", text: "Working" });
    const { list: media } = createMediaIndex(store);
    expect(media(threadId)).toMatchObject({ ids: [] });

    store.patchMessage(threadId, reply.id, { text: "Done: [plot.png](C:\\w\\plot.png)" });
    expect(media(threadId)).toMatchObject({ ids: [reply.id], name: ["plot.png"] });

    store.branchMessage(threadId, ask.id, "draw it bigger");
    expect(media(threadId)).toMatchObject({ ids: [] });
  });

  it("reads media across database pages without loading the chat transcript", () => {
    const writer = new Store(selection);
    const { threadId } = writer.createBot({}, { seedMessages: false });
    writer.appendMessage(threadId, { role: "bot", kind: "text", text: "[old.png](C:\\w\\old.png) [new.png](C:\\w\\new.png)" });
    for (let n = 0; n < 300; n++) writer.appendMessage(threadId, { role: "user", kind: "text", text: "no media" });
    writer.appendMessage(threadId, { role: "bot", kind: "text", text: "[new.png](C:\\w\\new.png)" });

    const store = new Store(selection);
    const activePath = vi.spyOn(store, "activePath");
    const media = createMediaIndex(store);
    const first = media.list(threadId);
    expect(first).toMatchObject({ name: ["new.png"], next: 1 });
    expect(media.page(threadId, first.v, 2)).toBeNull();
    const older = media.page(threadId, first.v, 1);
    expect(older).toMatchObject({ name: ["old.png"] });
    expect(older?.next).toBeUndefined();
    expect(media.page(threadId, first.v, 1)).toBe(older);
    expect(activePath).not.toHaveBeenCalled();
    expect(store.loaded(threadId)).toBe(false);
  });

  it("imports a flat legacy thread and follows its insertion order", () => {
    const store = new Store(selection);
    const { threadId } = store.createBot({}, { seedMessages: false });
    writeFileSync(join(DATA_DIR, `messages-${threadId}.json`), JSON.stringify([shot(5), shot(2)]));
    expect(createMediaIndex(store).list(threadId)).toMatchObject({ name: ["shot-2.png", "shot-5.png"] });
  });

  it("keeps a paged revision and its older pages through ordinary text replies", () => {
    const store = new Store(selection);
    const { threadId } = store.createBot({}, { seedMessages: false });
    store.appendMessage(threadId, { role: "bot", kind: "text", text: "[old.pdf](C:\\w\\old.pdf)" });
    for (let n = 0; n < 256; n++) store.appendMessage(threadId, { role: "user", kind: "text", text: "no media" });
    const media = createMediaIndex(store);
    const first = media.list(threadId);
    const old = media.page(threadId, first.v, 1);

    store.appendMessage(threadId, { role: "user", kind: "text", text: "thanks" });
    const reply = store.appendMessage(threadId, { role: "bot", kind: "text", text: "Working" });
    store.patchMessage(threadId, reply.id, { text: "You're welcome" });
    expect(media.list(threadId, first.v)).toEqual({ v: first.v });
    expect(media.page(threadId, first.v, 1)).toBe(old);

    store.patchMessage(threadId, reply.id, { text: "Here's [plot.png](C:\\w\\plot.png)" });
    expect(media.list(threadId, first.v)).toMatchObject({ name: ["plot.png"] });
  });

  it("carries attached sizes and reads linked sizes only on request", async () => {
    const store = new Store(selection);
    const { threadId } = store.createBot({}, { seedMessages: false });
    const report = join(DATA_DIR, "report.pdf");
    writeFileSync(report, "x".repeat(300));
    store.appendMessage(threadId, { role: "user", kind: "text", text: upload });
    store.appendMessage(threadId, { role: "bot", kind: "text", text: `[report.pdf](<${report}>), [gone.pdf](C:\\w\\gone.pdf) and [a.png](C:\\w\\a.png)` });

    const media = createMediaIndex(store);
    const index = media.list(threadId);
    expect("size" in index && index.size).toEqual([null, null, null, null, 2048]);
    writeFileSync(report, "x".repeat(500));
    expect(await media.size(threadId, index.v, 0)).toBe(500);
    expect(await media.size(threadId, index.v, 1)).toBeNull();
    expect(await media.size(threadId, index.v, 4)).toBeNull();
    expect(await media.size(threadId, "old", 0)).toBeUndefined();
    expect(await media.size("other", index.v, 0)).toBeUndefined();
    writeFileSync(report, "x".repeat(700));
    expect(await media.size(threadId, index.v, 0)).toBe(500);

    store.appendMessage(threadId, { role: "user", kind: "text", text: "thanks" });
    expect(media.list(threadId, index.v)).toEqual({ v: index.v });
    expect(await media.size(threadId, index.v, 0)).toBe(700);
  });

  it("lists a file whose link text holds inline code, and sees one arrive", () => {
    const store = new Store(selection);
    const { threadId } = store.createBot({}, { seedMessages: false });
    const link = "[report]`note`(C:\\w\\report.pdf)";
    store.appendMessage(threadId, { role: "bot", kind: "text", text: link });
    const media = createMediaIndex(store);
    expect(media.list(threadId)).toMatchObject({ name: ["report.pdf"] });

    const other = store.createBot({}, { seedMessages: false }).threadId;
    store.appendMessage(other, { role: "bot", kind: "text", text: "[a.png](C:\\w\\a.png)" });
    const first = media.list(other);
    store.appendMessage(other, { role: "bot", kind: "text", text: link });
    expect(media.list(other, first.v)).toMatchObject({ name: ["report.pdf", "a.png"] });
  });

  it("answers a size for a page it does not hold as expired", async () => {
    const store = new Store(selection);
    const { threadId } = store.createBot({}, { seedMessages: false });
    const report = join(DATA_DIR, "report.pdf");
    writeFileSync(report, "x".repeat(500));
    const rows: Message[] = [
      { id: "r0", at: START, role: "bot", kind: "text", text: `[report.pdf](<${report}>)` },
      ...Array.from({ length: 2_400 }, (_, n): Message => ({ id: `p${n}`, at: START + n + 1, role: "user", kind: "text", text: "no media" })),
    ];
    replaceThread(threadId, rows, "p2399");
    const media = createMediaIndex(store);

    const quiet = await media.snapshot(threadId);
    expect(quiet).toHaveLength(3);
    expect(await media.size(threadId, quiet[0]!.v, 0, 2)).toBe(500);

    store.appendMessage(threadId, { role: "bot", kind: "text", text: "[b.png](C:\\w\\b.png)" });
    const racing = media.snapshot(threadId);
    store.patchMessage(threadId, "p2399", { text: "[c.png](C:\\w\\c.png)" });
    const pages = await racing;
    expect(pages).toHaveLength(3);
    expect(await media.size(threadId, pages[0]!.v, 0, 2)).toBeUndefined();
  });

  it("keeps an older index stable when the next revision adds a file", () => {
    const store = new Store(selection);
    const { threadId } = store.createBot({}, { seedMessages: false });
    store.appendMessage(threadId, { role: "bot", kind: "text", text: "[a.pdf](C:\\w\\a.pdf)" });
    const { list: media } = createMediaIndex(store);

    const first = media(threadId);
    store.appendMessage(threadId, { role: "bot", kind: "text", text: "[b.pdf](C:\\w\\b.pdf)" });

    expect("name" in first && first.name).toEqual(["a.pdf"]);
    expect(media(threadId, first.v)).toMatchObject({ name: ["b.pdf", "a.pdf"] });
  });
});
