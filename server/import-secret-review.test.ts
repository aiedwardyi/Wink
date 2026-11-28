// Import Memory review: clean lines save at once, password-looking lines are held back for the user to Keep,
// machine keys never save and are never offered. Synthetic secrets only.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { aboutYouFile, aboutYouRoutes, aboutYouSources, addToAboutYou, addToBotMemory, botImportFile, factsOf, readImportRequest } from "./about-you.ts";
import { DATA_DIR } from "./config.ts";
import { importMemoryRoute, noteSendLocale } from "./memory-import-offer.ts";
import type { Message } from "./store.ts";
import { memoryFileRaw } from "./workspace.ts";
import { en, ko } from "../src/lib/i18n-catalog.ts";
import { removeTestData } from "./testing/test-home.ts";

const dir = join(DATA_DIR, "about-you");
const botDirs = ["keep-bot", "disk-bot"].map((id) => join(DATA_DIR, "workspaces", id));
const typed = (text: string) => ({ role: "user", kind: "text", text }) as Message;

// synthetic keys, built so no real-looking credential sits whole in the source
const OPENAI = `sk-proj-${"Zq7".repeat(8)}`;
const GITHUB = `ghp_${"Xy9w".repeat(9)}`;
const GITHUB_PAT = `github_pat_${"11AbCdEf".repeat(4)}`;
const AWS = `AKIA${"QZ7X".repeat(4)}`;
const JWT = `eyJhbGciOiJIUzI1NiJ9.${"eyJzdWIiOiIxIn0"}.${"c2lnbmF0dXJlLXNpZw"}`;
const PEM = ["-----BEGIN RSA PRIVATE KEY-----", "MIIEpAIBAAKCAQEA7synthetic7rowAAAAQQQQ1111", "c2hvcnQ=", "-----END RSA PRIVATE KEY-----"];

const flaggedPaste = [
  "- The user is Dana Park; call her Dana.",
  "- My password is hunter2-very-secret",
  "- Office door PIN: 4417",
  "- Plays cello on weekends.",
  "Source: ChatGPT",
].join("\n");

async function post(route: (req: IncomingMessage, res: ServerResponse) => Promise<void>, body: object) {
  let status = 0;
  let raw = "";
  const res = { writeHead: (code: number) => { status = code; }, setHeader: () => {}, end: (text: string) => { raw = text; } } as unknown as ServerResponse;
  await route(Object.assign(Readable.from([JSON.stringify(body)]), { headers: {} }) as unknown as IncomingMessage, res);
  return { status, body: JSON.parse(raw) };
}

const everyFile = (root: string): string[] => !existsSync(root) ? [] : readdirSync(root).flatMap((name) => {
  const path = join(root, name);
  return statSync(path).isDirectory() ? everyFile(path) : [path];
});

beforeEach(() => {
  removeTestData(dir);
  for (const bot of botDirs) removeTestData(bot);
  noteSendLocale("en");
});
afterEach(() => {
  removeTestData(dir);
  for (const bot of botDirs) removeTestData(bot);
  vi.restoreAllMocks();
});

describe("password-looking lines are held back, never dropped", () => {
  it("saves the clean lines and hands the flagged ones back, writing none of them", () => {
    const result = addToAboutYou(flaggedPaste, "2026-11-22");
    expect(result).toEqual({
      source: "ChatGPT", found: 2, added: 2, duplicates: 0, hidden: 0,
      flagged: ["My password is hunter2-very-secret", "Office door PIN: 4417"],
    });
    const saved = readFileSync(aboutYouFile(), "utf8");
    expect(saved).toContain("Plays cello on weekends.");
    expect(saved).not.toContain("hunter2");
    expect(saved).not.toContain("4417");
  });

  it("uses today's base detector as the flagger: every line it used to drop is now flagged, none lost", () => {
    // lines round E showed the base filter dropping with no word to the user
    const normal = ["Rotates passwords every 90 days.", "Hosts Secret Santa every December.", "Wants answers under 500 tokens."];
    const { facts, flagged, hidden } = factsOf(normal.map((line) => `- ${line}`).join("\n"));
    expect(hidden).toBe(0);
    expect([...facts, ...flagged].sort()).toEqual([...normal].sort());
    expect(flagged).toEqual(normal);
  });

  it("Keep saves the line as written, under the paste's source, to All my bots", async () => {
    await post(aboutYouRoutes.add, { text: flaggedPaste });
    const kept = await post(aboutYouRoutes.add, { keep: ["Office door PIN: 4417"], source: "ChatGPT" });
    expect(kept).toMatchObject({ status: 200, body: { added: 1, flagged: [], hidden: 0 } });
    expect(readFileSync(aboutYouFile(), "utf8")).toContain("- Office door PIN: 4417 (from ChatGPT, ");
    expect(aboutYouSources()).toEqual([{ source: "ChatGPT", facts: ["The user is Dana Park; call her Dana.", "Plays cello on weekends.", "Office door PIN: 4417"] }]);
    expect(readFileSync(aboutYouFile(), "utf8")).not.toContain("hunter2");
  });

  it("Keep on Only this bot saves to that bot's own import file, never the shared file or MEMORY.md", () => {
    addToBotMemory("keep-bot", flaggedPaste, "2026-11-22");
    expect(addToBotMemory("keep-bot", { keep: ["Office door PIN: 4417"], source: "ChatGPT" }, "2026-11-22")).toMatchObject({ added: 1 });
    expect(readFileSync(botImportFile("keep-bot"), "utf8")).toContain("- Office door PIN: 4417 (from ChatGPT, 2026-11-22)");
    expect(readFileSync(botImportFile("keep-bot"), "utf8")).not.toContain("hunter2");
    expect(memoryFileRaw("keep-bot")).not.toContain("4417");
    expect(existsSync(aboutYouFile())).toBe(false);
  });

  it("reads a paste or a Keep from one body shape, and refuses anything else", async () => {
    const read = (body: unknown) => readImportRequest(Readable.from([JSON.stringify(body)]) as IncomingMessage);
    expect(await read({ text: "x" })).toEqual({ text: "x" });
    expect(await read({ keep: ["x"], source: "ChatGPT" })).toEqual({ keep: ["x"], source: "ChatGPT" });
    expect(await read({ keep: [], source: "ChatGPT" })).toBeNull();
    expect(await read({ keep: ["x"] })).toBeNull();
  });

  it("a kept source name goes through the Source: guard, so a secret-looking name is never saved", () => {
    addToAboutYou({ keep: ["Likes tea."], source: "my password hunter2" }, "2026-11-22");
    const saved = readFileSync(aboutYouFile(), "utf8");
    expect(saved.split("\n").filter((line) => !line.startsWith("<!--"))).toEqual(["- Likes tea. (from another AI, 2026-11-22)", ""]);
    expect(saved).not.toContain("hunter2");
  });
});

describe("machine keys are always dropped and never offered for Keep", () => {
  it.each([
    ["sk-", `- OpenAI key: ${OPENAI}`],
    ["ghp_", `- GitHub token ${GITHUB}`],
    ["github_pat_", `- Deploy uses ${GITHUB_PAT}`],
    ["AKIA", `- AWS key id ${AWS}`],
    ["JWT", `- Session ${JWT}`],
    ["bare sk- in prose", `- The user's key is ${OPENAI} for the bot`],
    ["pk-", "- Publishable key pk-Ab7c9D2e"],
    ["Slack token, short", "- Slack xoxb-Ab7c9D2e"],
  ])("%s", (_name, line) => {
    const { facts, flagged, hidden } = factsOf(`${line}\n- Likes tea.`);
    expect(facts).toEqual(["Likes tea."]);
    expect(flagged).toEqual([]);
    expect(hidden).toBe(1);
  });

  it("a PEM block, every row of it, even the short last one", () => {
    const { facts, flagged, hidden } = factsOf(["- Likes tea.", ...PEM, "- Plays cello."].join("\n"));
    expect(facts).toEqual(["Likes tea.", "Plays cello."]);
    expect(flagged).toEqual([]);
    expect(hidden).toBe(1);
  });

  it("a PEM block cut off before END stops at the next ordinary line", () => {
    const { facts, flagged } = factsOf(["- Likes tea.", ...PEM.slice(0, 3), "- Plays cello."].join("\n"));
    expect(facts).toEqual(["Likes tea.", "Plays cello."]);
    expect(flagged).toEqual([]);
  });

  it("a Keep that carries a machine key saves nothing", () => {
    expect(addToAboutYou({ keep: [`OpenAI key: ${OPENAI}`, PEM[0]!], source: "ChatGPT" }, "2026-11-22")).toMatchObject({ added: 0, hidden: 2 });
    expect(existsSync(aboutYouFile())).toBe(false);
  });
});

describe("the chat route never echoes a flagged line", () => {
  async function chat(text: string) {
    let raw = "";
    const res = { writeHead: () => {}, setHeader: () => {}, end: (body: string) => { raw = body; } } as unknown as ServerResponse;
    await importMemoryRoute(Object.assign(Readable.from(["{}"]), { headers: {} }) as unknown as IncomingMessage, res, {
      caller: () => ({ botId: "b1", threadId: "t1" }),
      ownerChat: () => true,
      messages: () => [typed(text)],
      open: () => () => true,
    });
    return String(JSON.parse(raw).text);
  }

  it("names how many and where to review them, not what they say", async () => {
    const text = await chat(flaggedPaste);
    expect(text).toContain("Added 2 new.");
    expect(text).toContain(en["aboutYou.flaggedChat"].replace("{count}", "2"));
    expect(text).toContain("Settings > Import Memory");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("4417");
    expect(readFileSync(aboutYouFile(), "utf8")).not.toContain("hunter2");
  });

  it("a paste of only flagged lines says so, not that no facts were found", async () => {
    const text = await chat("- My password is hunter2-very-secret\nSource: ChatGPT");
    expect(text).toBe(`Import Memory says: ${en["aboutYou.flaggedChatOne"]}\nTell the user this result.`);
    noteSendLocale("ko");
    expect(await chat("- My password is hunter2-very-secret\nSource: ChatGPT")).toContain(ko["aboutYou.flaggedChatOne"]);
  });
});

describe("flagged lines are never written anywhere", () => {
  it("after an import with flags, no file under the data dir holds a flagged line or a machine key", async () => {
    const warn = vi.spyOn(console, "warn");
    const log = vi.spyOn(console, "log");
    const error = vi.spyOn(console, "error");
    mkdirSync(dir, { recursive: true });
    await post(aboutYouRoutes.add, { text: `${flaggedPaste}\n- Key ${OPENAI}` });
    addToBotMemory("disk-bot", flaggedPaste, "2026-11-22");
    for (const path of everyFile(DATA_DIR)) {
      const text = readFileSync(path, "latin1");
      for (const secret of ["hunter2", "door PIN: 4417", OPENAI]) expect(text, path).not.toContain(secret);
    }
    for (const spy of [warn, log, error]) expect(JSON.stringify(spy.mock.calls)).not.toMatch(/hunter2|4417|sk-proj/);
  });
});
