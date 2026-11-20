import { rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";

import type { Message } from "@/state/store";

import { DATA_DIR } from "../../server/config.ts";
import { Store } from "../../server/store.ts";
import { createThreadRoutes } from "../../server/thread-routes.ts";

import { mediaKey, messageRefs } from "./chat-media";
import { decodeMedia, loadMedia, mediaMonths, withLive, type MediaWire } from "./media-index";
import { mediaList } from "./media-viewer";
import { linkedFileSrc } from "./show-pane";
import type { MediaFile } from "./show-media";

const mock = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/lib/api-request", () => ({ request: mock.request }));

const AT = 1_790_000_000;
const file = (key: string, at = 0): MediaFile => ({ key, name: key, at, src: key, image: true });

describe("media index", () => {
  it("draws each entry the way the Media tab drew it from messages", () => {
    const wire: MediaWire = {
      v: "1",
      ids: ["b2", "b2", "b1", "u1", "u1"],
      at: [AT, AT, AT, AT, AT],
      kind: "ullaf",
      name: ["chart.png", "deck.pdf", "shot.png", "abc-1.png", "notes.docx"],
      ref: ["https://example.com/chart.png", "C:\\w\\deck.pdf", "C:\\w\\shot.png", "", "C:\\att\\notes.docx"],
      size: [null, 300, null, null, 2048],
    };
    const at = AT * 1000;
    const deck = linkedFileSrc("t1", "C:\\w\\deck.pdf");
    const shot = linkedFileSrc("t1", "C:\\w\\shot.png");
    expect(decodeMedia("t1", wire)).toEqual([
      { key: "https://example.com/chart.png", name: "chart.png", at, src: "https://example.com/chart.png", image: true },
      { key: deck, name: "deck.pdf", at, src: deck, path: "C:\\w\\deck.pdf", size: 300, tap: { threadId: "t1", path: "C:\\w\\deck.pdf" } },
      { key: shot, name: "shot.png", at, src: shot, path: "C:\\w\\shot.png", image: true, tap: { threadId: "t1", path: "C:\\w\\shot.png" } },
      { key: "/api/attachments/abc-1.png", name: "abc-1.png", at, src: "/api/attachments/abc-1.png", image: true },
      { key: "C:\\att\\notes.docx", name: "notes.docx", at, src: linkedFileSrc("t1", "C:\\att\\notes.docx"), path: "C:\\att\\notes.docx", size: 2048, tap: { threadId: "t1", path: "C:\\att\\notes.docx" } },
    ]);
  });

  it("finds the same pictures the transcript shows", () => {
    const messages: Message[] = [
      { id: "u1", at: 1, role: "user", kind: "text", text: 'look\n<attached-image path="C:\\att\\abc-1.png" />\n<attached-image path="C:\\att\\not an id.png" />' },
      { id: "s1", at: 2, role: "bot", kind: "screen", image: "C:\\att\\screen-2.webp" },
      { id: "b1", at: 3, role: "bot", kind: "text", text: "![a](/api/attachments/abc-3.png) ![](https://example.com/x/y.jpg?s=1) ![nope](javascript:alert(1)) ![data](data:image/png;base64,AAAA) ![b][ref] ![file](/api/threads/t1/linked-file?path=C%3A%5Cw%5Cplot.png)\n\n[ref]: https://example.com/ref.gif" },
      { id: "b2", at: 4, role: "bot", kind: "text", text: "![gone](/api/attachments/gone.png)", summarized: true },
    ];
    const found = messages.map((message) => {
      const pictures = messageRefs(message).filter((ref) => ref.kind === "a" || ref.kind === "u").map((ref) => ({ src: mediaKey("t1", ref), name: ref.name }));
      expect(pictures).toEqual(mediaList([message]).map(({ src, name }) => ({ src, name })));
      return pictures.length;
    });
    expect(found).toEqual([1, 1, 4, 0]);
  });

  it("lists a long chat's oldest picture in the first answer", async () => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    const { threadId } = store.createBot({}, { seedMessages: false });
    store.appendMessage(threadId, { role: "bot", kind: "text", text: "[old.png](C:\\w\\old.png)" });
    for (let n = 0; n < 1_000; n++) store.appendMessage(threadId, { role: "user", kind: "text", text: `note ${n}` });
    store.appendMessage(threadId, { role: "bot", kind: "text", text: "[new.png](C:\\w\\new.png)" });
    const route = createThreadRoutes({ dataDir: DATA_DIR, store, threadSyncGate: { enabled: false }, pullSyncedThread: vi.fn() } as unknown as Parameters<typeof createThreadRoutes>[0]);
    mock.request.mockImplementation(async (path: string) => {
      let body = "";
      const res = { writeHead: () => {}, end: (text: string) => { body = text; } } as unknown as ServerResponse;
      await route.media(res, ["", threadId] as RegExpMatchArray, new URL(path, "http://localhost"));
      return JSON.parse(body);
    });

    const { files } = await loadMedia(threadId);

    expect(files.map((each) => each.name)).toEqual(["new.png", "old.png"]);
  });

  it("keeps the same list while the open chat gains nothing new", () => {
    const index = [file("b"), file("a")];
    expect(withLive(index, [file("b")])).toBe(index);
    const grown = withLive(index, [file("c"), file("b")]);
    expect(grown.map((each) => each.key)).toEqual(["c", "b", "a"]);
    expect(withLive(index, [file("c"), file("b")])).toBe(grown);
    expect(withLive(index, [])).toBe(index);
  });

  it("groups by month, newest first, named in English and Korean", () => {
    const files: MediaFile[] = [
      file("late.png", new Date(2026, 10, 20).getTime()),
      { key: "notes.pdf", name: "notes.pdf", at: new Date(2026, 10, 2).getTime() },
      file("early.png", new Date(2026, 9, 31).getTime()),
    ];
    const months = mediaMonths(files, "en");
    expect(months.map((month) => [month.label, month.images.map((each) => each.key), month.files.map((each) => each.key)])).toEqual([
      ["November 2026", ["late.png"], ["notes.pdf"]],
      ["October 2026", ["early.png"], []],
    ]);
    expect(mediaMonths(files, "ko").map((month) => month.label)).toEqual(["2026년 11월", "2026년 10월"]);
  });
});
