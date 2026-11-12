import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { buildMediaIndex, createMediaIndex } from "./media-index.ts";
import { closeMessageDb } from "./message-db.ts";
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

    const index = buildMediaIndex("t1", path);

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
    const media = createMediaIndex(store);

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
    const media = createMediaIndex(store);
    expect(media(threadId)).toMatchObject({ ids: [] });

    store.patchMessage(threadId, reply.id, { text: "Done: [plot.png](C:\\w\\plot.png)" });
    expect(media(threadId)).toMatchObject({ ids: [reply.id], name: ["plot.png"] });

    store.branchMessage(threadId, ask.id, "draw it bigger");
    expect(media(threadId)).toMatchObject({ ids: [] });
  });
});
