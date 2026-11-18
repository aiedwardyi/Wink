import { readFileSync, rmSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
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

  it("reads only the rows naming the file and leaves the chat unloaded", async () => {
    const { linkedRows } = await rowsModule();
    const { threadId, link } = chat();
    const store = new Store(selection);
    const whole = vi.spyOn(store, "messagesFor");
    const rows = [...linkedRows(store)(threadId, picture.toLowerCase())];
    expect(rows.map((row) => row.id)).toEqual([link.id]);
    expect(whole).not.toHaveBeenCalled();
    expect(store.loaded(threadId)).toBe(false);
  });

  it("answers again without a read until the chat changes", async () => {
    const { linkedRows } = await rowsModule();
    const { threadId } = chat();
    const store = new Store(selection);
    const rows = linkedRows(store);
    expect([...rows(threadId, picture)]).toHaveLength(1);
    expect(rows(threadId, picture)).toBe(rows(threadId, picture));
    const later = store.patchRow(threadId, store.activeLeaf(threadId)!, { text: `Again: [shot](<${picture}>)` })!;
    expect([...rows(threadId, picture)].map((row) => row.text)).toEqual([later.text]);
  });

  it("uses the loaded thread when there is one", async () => {
    const { linkedRows } = await rowsModule();
    const { threadId, link } = chat();
    const store = new Store(selection);
    store.messagesFor(threadId);
    expect([...linkedRows(store)(threadId, picture)].map((row) => row.id)).toContain(link.id);
  });

  it("keys on a run of the name every link form keeps", async () => {
    const { nameRun } = await rowsModule();
    expect(nameRun(picture)).toBe("shot_2.png");
    expect(nameRun("/tmp/주간 보고서.pdf")).toBe(".pdf");
    expect(nameRun("/tmp/사진")).toBe("");
  });

  it("the linked-file route never loads the whole thread", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const route = source.slice(source.indexOf("/linked-(file(?:\\/.*)?|folder)$/"), source.indexOf("// serving is name-locked to the attachments dir"));
    expect(route).toContain("serveLinkedFolder : serveLinkedFile");
    expect(route).not.toMatch(/store\.(messagesFor|activePath)\(/);
  });
});
