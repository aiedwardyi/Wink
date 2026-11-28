import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { aboutYouRoutes, aboutYouSources, ABOUT_YOU_MAX_PASTE } from "./about-you.ts";
import { DATA_DIR } from "./config.ts";
import { importMemoryPins } from "./import-memory-pin.ts";
import { importMemoryRoute, importMemoryTool, noteSendLocale, type ImportMemoryDeps } from "./memory-import-offer.ts";
import type { Message } from "./store.ts";
import { en } from "../src/lib/i18n-catalog.ts";
import { removeTestData } from "./testing/test-home.ts";

const dir = join(DATA_DIR, "about-you");
const typed = (text: string) => ({ role: "user", kind: "text", text }) as Message;
const reply = (text: string) => ({ role: "bot", kind: "text", text }) as Message;
const paste = ["- The user is Dana Park; call her Dana.", "- Speaks Korean and English.", "Source: ChatGPT"].join("\n");

async function call(body: object, chat: Message[], ownerChat = true, open: ImportMemoryDeps["open"] = () => true) {
  let status = 0;
  let raw = "";
  const res = { writeHead: (code: number) => { status = code; }, setHeader: () => {}, end: (text: string) => { raw = text; } } as unknown as ServerResponse;
  const deps: ImportMemoryDeps = {
    caller: () => ({ botId: "b1", threadId: "t1" }),
    ownerChat: () => ownerChat,
    messages: () => chat,
    open,
    now: () => new Date(2026, 10, 19).getTime(),
  };
  await importMemoryRoute(Object.assign(Readable.from([JSON.stringify(body)]), { headers: {} }) as unknown as IncomingMessage, res, deps);
  return { status, text: String(JSON.parse(raw).text ?? JSON.parse(raw).error) };
}

beforeEach(() => {
  removeTestData(dir);
  noteSendLocale("en");
});
afterEach(() => removeTestData(dir));

describe("import_memory tool for a new chat", () => {
  it("is on for a new chat's first typed message while Import Memory is empty", () => {
    expect(importMemoryTool([typed("hi")])).toBe(true);
    expect(importMemoryTool([], 1)).toBe(true);
    expect(importMemoryTool([])).toBe(false);
  });

  it("is off once anything is imported, including facts synced from another PC", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "MEMORY.md"), "- Lives in Seoul. (from ChatGPT, 2026-11-18)\n");
    expect(importMemoryTool([typed("hi")])).toBe(false);
  });

  it("is off after the user says no", async () => {
    expect(await call({ decline: true }, [typed("no thanks")])).toEqual({ status: 200, text: expect.stringContaining("no bot offers this again") });
    expect(importMemoryTool([typed("hi")])).toBe(false);
    expect(existsSync(join(dir, "MEMORY.md"))).toBe(false);
  });

  it("stays on for the first 3 typed messages only", () => {
    expect(importMemoryTool([typed("hi"), reply("hello"), typed(paste)])).toBe(true);
    expect(importMemoryTool([typed("a"), reply("b"), typed("c"), reply("d"), typed("e"), reply("f"), typed("g")])).toBe(false);
  });

  it("stays listed for the session that started with it, but saves only in the first 3 typed messages", async () => {
    const pins = importMemoryPins();
    const chat = [typed("hi")];
    expect(pins.forTurn("t1", "claude", undefined, importMemoryTool(chat))).toBe(true);
    chat.push(reply("hello"), typed("b"), reply("c"), typed("d"), reply("e"), typed(paste));
    expect(pins.forTurn("t1", "claude", "s1", importMemoryTool(chat))).toBe(true);
    expect((await call({}, chat, true, pins.open)).text).toContain("Settings > Import Memory still works");
    expect(existsSync(join(dir, "MEMORY.md"))).toBe(false);
    expect(pins.forTurn("t1", "claude", undefined, importMemoryTool(chat))).toBe(false);
  });

  it("reads only the start of a heavy chat", () => {
    let read = 0;
    const heavy = { *[Symbol.iterator]() { for (let i = 0; i < 1e9; i++) { read++; yield i % 2 ? reply("r") : typed("q"); } } } as unknown as Message[];
    expect(importMemoryTool(heavy)).toBe(false);
    expect(read).toBeLessThan(10);
  });

  it("ends once Settings saves a fact", async () => {
    expect(importMemoryTool([typed("hi")])).toBe(true);
    const res = { writeHead: () => {}, setHeader: () => {}, end: () => {} } as unknown as ServerResponse;
    await aboutYouRoutes.add(Readable.from([JSON.stringify({ text: "- I play cello.\nSource: ChatGPT" })]) as IncomingMessage, res);
    expect(importMemoryTool([typed("hi")])).toBe(false);
  });
});

describe("import_memory saves through the Settings path", () => {
  it("saves only the facts not already saved", async () => {
    const answer = typed("- I play cello.\n- Call me Dana.\n- I grow tomatoes.\n- I bike to work.\n- I use a paper calendar.\nSource: ChatGPT");
    await call({}, [typed("- I play cello.\nSource: ChatGPT")]);
    const result = await call({}, [typed("hi"), reply("hello"), answer]);
    expect(result.text).toContain("Added 4 new.");
    expect(result.text).toContain("Saved facts:\n- Call me Dana.\n- I grow tomatoes.\n- I bike to work.\n- I use a paper calendar.");
    expect(result.text).not.toContain("I play cello.");
  });

  it("lists only newly saved facts for a partial import", async () => {
    await call({}, [typed("- Already saved.\nSource: ChatGPT")]);
    const text = (await call({}, [typed("- Already saved.\n- My password is hunter2-very-secret\n- Likes tea.\n- Plays tennis.\nSource: ChatGPT")])).text;
    expect(text).toContain("Saved facts:\n- Likes tea.\n- Plays tennis.");
    expect(text).not.toContain("Already saved.");
    expect(text).not.toContain("hunter2");
    expect(text).toContain("only from the saved facts list");
  });

  it("reports when the saved facts list is capped", async () => {
    const text = (await call({}, [typed(`${Array.from({ length: 10 }, (_, i) => `- New fact ${i}.`).join("\n")}\nSource: ChatGPT`)])).text;
    expect(text).toContain("- New fact 7.\n+2 more");
    expect(text).not.toContain("New fact 8.");
  });
  it("saves the user's pasted message and reports what Settings reports", async () => {
    const result = await call({}, [typed("hi"), reply("offer"), typed(paste)]);
    expect(result).toEqual({ status: 200, text: expect.stringMatching(/^Import Memory says: Added 2 new\.\nTell the user this result\.\n/) });
    expect(aboutYouSources()).toEqual([{ source: "ChatGPT", facts: ["The user is Dana Park; call her Dana.", "Speaks Korean and English."] }]);
    expect((await call({}, [typed(paste)])).text).toContain(en["aboutYou.nothingNew"]);
  });

  it("after a save that added facts, tells the bot to say what it now knows, from saved facts only", async () => {
    const text = (await call({}, [typed("hi"), reply("offer"), typed(paste)])).text;
    expect(text).toContain("Added 2 new.");
    expect(text).toContain("tell them what you now know");
    expect(text).toContain("up to 5 short bullets");
    expect(text).toContain("Use only from the saved facts list");
    expect(text).toContain("The user is Dana Park; call her Dana.");
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

  it("saves every fact past the prompt's 200-line cut", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "MEMORY.md"), Array.from({ length: 199 }, (_, i) => `- Fact ${i}. (from Gemini, 2026-11-18)`).join("\n") + "\n");
    const text = (await call({}, [typed(paste)])).text;
    expect(text).toContain("Added 2 new.");
    expect(text).not.toContain("not added");
    expect(aboutYouSources().find((entry) => entry.source === "ChatGPT")?.facts).toEqual(["The user is Dana Park; call her Dana.", "Speaks Korean and English."]);
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
      "const agents = instance.adapter.capabilities.agentsMcp === true ? agentsIntegration(bot.id, bot.threadId, 0, false, false, false, importMemoryTool(store.activePathBack(bot.threadId), 1), ownerFileStart(bot.id, bot.threadId, 0, true)) : undefined;",
      "integrations.agents = agentsIntegration(bot.id, threadId, commsDepth, false, readOnly, false, importMemory, ownerFileStart(bot.id, threadId, commsDepth, turnStartedByUser(opts)));",
    ]);
    expect(mounts.find((line) => line.includes("hop"))).not.toContain("importMemory");
  });
});
