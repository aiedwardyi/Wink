import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { aboutYouSources, ABOUT_YOU_MAX_PASTE } from "./about-you.ts";
import { DATA_DIR } from "./config.ts";
import { importMemoryRoute, importMemoryTurn, importOfferNote, noteSendLocale, type ImportMemoryDeps } from "./memory-import-offer.ts";
import type { Message } from "./store.ts";
import { en, ko } from "../src/lib/i18n-catalog.ts";

const dir = join(DATA_DIR, "about-you");
const typed = (text: string) => ({ role: "user", kind: "text", text }) as Message;
const reply = (text: string) => ({ role: "bot", kind: "text", text }) as Message;
const paste = ["- The user is Dana Park; call her Dana.", "- Speaks Korean and English.", "Source: ChatGPT"].join("\n");

async function call(body: object, chat: Message[], ownerChat = true) {
  let status = 0;
  let raw = "";
  const res = { writeHead: (code: number) => { status = code; }, setHeader: () => {}, end: (text: string) => { raw = text; } } as unknown as ServerResponse;
  const deps: ImportMemoryDeps = {
    caller: () => ({ botId: "b1", threadId: "t1" }),
    ownerChat: () => ownerChat,
    messages: () => chat,
    now: () => new Date(2026, 10, 19).getTime(),
  };
  await importMemoryRoute(Object.assign(Readable.from([JSON.stringify(body)]), { headers: {} }) as unknown as IncomingMessage, res, deps);
  return { status, text: String(JSON.parse(raw).text ?? JSON.parse(raw).error) };
}

beforeEach(() => {
  rmSync(dir, { recursive: true, force: true });
  noteSendLocale("en");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("new bot import offer", () => {
  it("offers on a new chat's first typed message while Import Memory is empty", () => {
    expect(importMemoryTurn([typed("hi")])).toEqual({ offer: true, tool: true });
    expect(importMemoryTurn([], 1)).toEqual({ offer: true, tool: true });
  });

  it("never offers once anything is imported, including facts synced from another PC", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "MEMORY.md"), "- Lives in Seoul. (from ChatGPT, 2026-11-18)\n");
    expect(importMemoryTurn([typed("hi")])).toEqual({ offer: false, tool: false });
  });

  it("never offers again after the user says no", async () => {
    expect(await call({ decline: true }, [typed("no thanks")])).toEqual({ status: 200, text: expect.stringContaining("no bot offers this again") });
    expect(importMemoryTurn([typed("hi")])).toEqual({ offer: false, tool: false });
    expect(existsSync(join(dir, "MEMORY.md"))).toBe(false);
  });

  it("offers only on the first turn: a send during it or after keeps the tool, not the offer", () => {
    expect(importMemoryTurn([typed("hi"), typed("also this")])).toEqual({ offer: false, tool: true });
    expect(importMemoryTurn([typed("hi"), reply("hello"), typed(paste)])).toEqual({ offer: false, tool: true });
    expect(importMemoryTurn([typed("a"), reply("b"), typed("c"), reply("d"), typed("e"), reply("f"), typed("g")])).toEqual({ offer: false, tool: false });
  });

  it("reads only the start of a heavy chat", () => {
    let read = 0;
    const heavy = { *[Symbol.iterator]() { for (let i = 0; i < 1e9; i++) { read++; yield i % 2 ? reply("r") : typed("q"); } } } as unknown as Message[];
    expect(importMemoryTurn(heavy)).toEqual({ offer: false, tool: false });
    expect(read).toBeLessThan(10);
  });

  it("ends the reply with the fixed 3-step offer, saying to paste in the other AI's own app, not Wink", () => {
    const steps = (note: string) => note.slice(note.indexOf("Offer only in this reply.") + 25, note.indexOf("```text")).trim();
    expect(steps(importOfferNote())).toBe([
      "Want me to know what ChatGPT, Claude, Gemini, Grok or Muse already knows about you? It takes a minute:",
      "1. Copy the prompt in the box below.",
      "2. Paste it into that AI, on its own app or website (not here in Wink).",
      "3. Copy its answer and paste it back here.",
    ].join("\n"));
    expect(importOfferNote()).toContain("word for word");
    noteSendLocale("ko");
    const ko = steps(importOfferNote());
    expect(ko.split("\n").map((line) => line.slice(0, 3))).toEqual([ko.slice(0, 3), "1. ", "2. ", "3. "]);
    expect(ko).toContain("ChatGPT, Claude, Gemini, Grok, Muse가");
    expect(ko).toContain("(여기 Wink 말고요)");
  });

  it("asks for the exact Settings prompt in the user's language", () => {
    expect(importOfferNote()).toContain(`\`\`\`text\n${en["aboutYou.prompt"]}\n\`\`\``);
    noteSendLocale("ko");
    expect(importOfferNote()).toContain(`\`\`\`text\n${ko["aboutYou.prompt"]}\n\`\`\``);
  });
});

describe("import_memory saves through the Settings path", () => {
  it("saves the user's pasted message and reports what Settings reports", async () => {
    const result = await call({}, [typed("hi"), reply("offer"), typed(paste)]);
    expect(result).toEqual({ status: 200, text: expect.stringMatching(/^Import Memory says: Added 2 new\.\nTell the user this result\.\n/) });
    expect(aboutYouSources()).toEqual([{ source: "ChatGPT", facts: ["The user is Dana Park; call her Dana.", "Speaks Korean and English."] }]);
    expect((await call({}, [typed(paste)])).text).toContain(en["aboutYou.nothingNew"]);
  });

  it("after a save that added facts, tells the bot to say what it now knows, from the paste only", async () => {
    const text = (await call({}, [typed("hi"), reply("offer"), typed(paste)])).text;
    expect(text).toContain("Added 2 new.");
    expect(text).toContain("tell them what you now know");
    expect(text).toContain("3-5 short bullets");
    expect(text).toContain("Use only what the paste says");
    expect(text).not.toContain("Dana");
    expect(text).not.toMatch(/wrong or missing/i);
    noteSendLocale("ko");
    const ko = (await call({}, [typed(paste.replace("Dana", "Dan"))])).text;
    expect(ko).toContain("글머리표");
    expect(ko).toContain("한국어로");
  });

  it("gives no recap when nothing was added, and leaves errors unchanged", async () => {
    await call({}, [typed(paste)]);
    const again = (await call({}, [typed(paste)])).text;
    expect(again).toBe(`Import Memory says: ${en["aboutYou.nothingNew"]}\nTell the user this result.`);
    expect((await call({}, [typed("   ")])).text).toBe(`Import Memory says: ${en["aboutYou.noFacts"]}\nTell the user this result.`);
    expect((await call({}, [typed("x".repeat(ABOUT_YOU_MAX_PASTE + 1))])).text).toBe(`Import Memory says: ${en["aboutYou.tooLarge"]}\nTell the user this result.`);
  });

  it("imports the paste the bot saw, not a later steered line or a side quick question", async () => {
    const steered = { ...typed("thanks, take your time"), steered: true } as Message;
    const quickAsk = { ...typed("what time is it?"), quick: { state: "asked" } } as Message;
    expect((await call({}, [typed("hi"), reply("offer"), typed(paste), steered, quickAsk])).text).toContain("Added 2 new.");
    expect(aboutYouSources()).toEqual([{ source: "ChatGPT", facts: ["The user is Dana Park; call her Dana.", "Speaks Korean and English."] }]);
  });

  it("refuses a paste over 4 MB with the Settings message", async () => {
    const result = await call({}, [typed("x".repeat(ABOUT_YOU_MAX_PASTE + 1))]);
    expect(result.text).toContain(en["aboutYou.tooLarge"]);
    expect(existsSync(join(dir, "MEMORY.md"))).toBe(false);
  });

  it("counts what a full memory left out", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "MEMORY.md"), Array.from({ length: 199 }, (_, i) => `- Fact ${i}. (from Gemini, 2026-11-18)`).join("\n") + "\n");
    expect((await call({}, [typed(paste)])).text).toContain("Added 1 new. Memory is full: 1 not added.");
  });

  it("answers a Korean user in Korean", async () => {
    noteSendLocale("ko");
    expect((await call({}, [typed(paste)])).text).toContain("새로 2개 추가했어요.");
  });

  it("never writes from a room: other people's text stays out of the owner's memory", async () => {
    expect((await call({}, [typed(paste)], false)).status).toBe(403);
    expect((await call({ decline: true }, [typed("no")], false)).status).toBe(403);
    expect(existsSync(dir)).toBe(false);
  });

  it("is offered and mounted only in the owner's own 1:1 turns", () => {
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(index).toContain("turnStartedByUser(opts) && opts?.readOnly !== true && instance.adapter.capabilities.agentsMcp === true && !notOwnerChats().has(threadId)");
    const mounts = index.split("\n").filter((line) => line.includes("agentsIntegration(bot.id"));
    expect(mounts.filter((line) => line.includes("importMemory")).map((line) => line.trim())).toEqual([
      "const agents = instance.adapter.capabilities.agentsMcp === true ? agentsIntegration(bot.id, bot.threadId, 0, false, false, false, importMemoryTurn(store.activePathBack(bot.threadId), 1).tool) : undefined;",
      "integrations.agents = agentsIntegration(bot.id, threadId, commsDepth, false, readOnly, false, importMemory.tool);",
    ]);
    expect(mounts.find((line) => line.includes("hop"))).not.toContain("importMemory");
  });
});
