import { mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { VerifyCardData } from "../shared/live-verify.ts";
import type { Message } from "./store.ts";
import { createVerifyDoc, type DocStart } from "./verify-doc.ts";
import { createTempDirs } from "./testing/cleanup.ts";
import { docxFixture } from "./testing/docx-fixture.ts";

const temps = createTempDirs();
const LINES = Array.from({ length: 60 }, (_, i) => `${i + 1}번째 문단입니다. 오늘 회의에서 정한 내용을 차례로 적어 둡니다.`);
let root: string;
let messages: Message[];
let busy: boolean;
let generate: ReturnType<typeof vi.fn<(prompt: string, opts?: { signal?: AbortSignal }) => Promise<string>>>;
let engine: { generateText: typeof generate } | null;
let log: ReturnType<typeof vi.fn<(line: string) => void>>;
let doc: ReturnType<typeof createVerifyDoc>;
const start = (paths: string[]): DocStart => ({ botId: "bot", threadId: "thread", roots: [root], paths });
const cards = () => messages.filter(message => message.verify).map(message => message.verify as VerifyCardData);
const done = () => vi.waitFor(() => expect(cards().at(-1)?.status).toBe("completed"), { timeout: 5_000 });
const store = {
  bot: () => ({ id: "bot", name: "Atlas", color: "blue" }),
  conversationForBot: () => ({ bot: { id: "bot" }, group: undefined }),
  appendMessage: (_threadId: string, message: Omit<Message, "id" | "at">) => {
    const row = { ...message, id: `m${messages.length}`, at: Date.now() } as Message;
    messages.push(row);
    return row;
  },
  patchMessage: (_threadId: string, id: string, patch: Partial<Message>) => {
    const index = messages.findIndex(message => message.id === id);
    if (index < 0) return null;
    messages[index] = { ...messages[index]!, ...patch };
    return messages[index]!;
  },
  messagesFor: () => messages,
};

afterEach(() => { doc.dispose(); temps.remove(); });

beforeEach(async () => {
  root = await realpath(temps.make(join(tmpdir(), "wink-verify-doc-")));
  messages = [];
  busy = false;
  generate = vi.fn().mockResolvedValue(JSON.stringify({ findings: [], names: [], dates: [] }));
  engine = { generateText: generate };
  log = vi.fn();
  doc = createVerifyDoc({ store: store as never, instanceFor: () => engine, busy: () => busy, deviceId: () => "device", broadcastPatch: vi.fn(), log, quietMs: 20 });
  await writeFile(join(root, "script.md"), LINES.join("\n"));
});

it("checks a document once after 20 quick edits", async () => {
  for (let i = 0; i < 20; i++) doc.schedule(start(["script.md"]));
  await done();
  await delay(60);
  expect(cards()).toHaveLength(1);
  expect(generate).toHaveBeenCalledTimes(1);
  expect(cards()[0]).toMatchObject({ owner: "bot", site: "script.md", mode: "auto", doc: { pages: 2, lines: 60, chunks: [1, 1] } });
});

it("does not check the same content twice", async () => {
  doc.schedule(start(["script.md"]));
  await done();
  doc.schedule(start(["script.md"]));
  await delay(100);
  expect(cards()).toHaveLength(1);
  expect(generate).toHaveBeenCalledTimes(1);
});

it("waits while the bot is still working", async () => {
  busy = true;
  doc.schedule(start(["script.md"]));
  await delay(100);
  expect(cards()).toHaveLength(0);
  busy = false;
  await done();
});

it("skips dev files, notes in code projects, memory, small files and other kinds, but checks a .docx anywhere", async () => {
  const big = LINES.join("\n");
  await mkdir(join(root, "app"), { recursive: true });
  await mkdir(join(root, "memory"), { recursive: true });
  await writeFile(join(root, "README.md"), big);
  await writeFile(join(root, "app", "package.json"), "{}");
  await writeFile(join(root, "app", "notes.md"), big);
  await writeFile(join(root, "memory", "today.md"), big);
  await writeFile(join(root, "small.txt"), "짧은 메모");
  await writeFile(join(root, "page.html"), big);
  for (const path of ["README.md", "app/notes.md", "memory/today.md", "small.txt", "page.html", "../outside.md"]) doc.schedule(start([path]));
  await delay(150);
  expect(cards()).toHaveLength(0);
  await writeFile(join(root, "app", "brief.docx"), docxFixture(LINES));
  doc.schedule(start(["app/brief.docx"]));
  await done();
  expect(cards()[0]!.site).toBe("app/brief.docx");
});

it("reports findings by line and page, then counts them fixed on the next check", async () => {
  const lines = [...LINES];
  lines[49] = "계약서는 다음 주에 보내 드리면 되요.";
  await writeFile(join(root, "script.md"), lines.join("\n"));
  generate.mockResolvedValueOnce(JSON.stringify({ findings: [{ kind: "spelling", quote: "되요", fix: "돼요", note: "맞춤법" }], names: [], dates: [] }));
  doc.schedule(start(["script.md"]));
  await done();
  expect(cards()[0]!.doc).toMatchObject({ by: { spelling: 1 }, findingTotal: 1, findings: [{ kind: "spelling", line: 50, page: 2, quote: "되요", fix: "돼요", note: "맞춤법" }] });
  lines[49] = "계약서는 다음 주에 보내 드리면 돼요.";
  await writeFile(join(root, "script.md"), lines.join("\n"));
  doc.schedule(start(["script.md"]));
  await vi.waitFor(() => expect(cards()).toHaveLength(2));
  await done();
  expect(cards()[1]).toMatchObject({ fixed: 1, doc: { findingTotal: 0 } });
});

it("stores the replay on the card, so a reloaded chat can watch it", async () => {
  doc.schedule(start(["script.md"]));
  await done();
  await vi.waitFor(() => expect(cards().at(-1)!.replay?.at(-1)).toBe(cards().at(-1)!.runId), { timeout: 5_000 });
});

it("lets a newer edit replace a running check on the same card", async () => {
  generate.mockImplementationOnce((_prompt, opts) => new Promise((_resolve, reject) => opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
  doc.schedule(start(["script.md"]));
  await vi.waitFor(() => expect(cards()[0]?.status).toBe("running"));
  await writeFile(join(root, "script.md"), [...LINES, "마지막 문단을 덧붙였어요."].join("\n"));
  doc.schedule(start(["script.md"]));
  await done();
  expect(cards()).toHaveLength(1);
  expect(cards()[0]!.doc!.lines).toBe(61);
});

it("does nothing when the bot has no text engine", async () => {
  engine = null;
  doc.schedule(start(["script.md"]));
  await delay(100);
  expect(cards()).toHaveLength(0);
  expect(log).toHaveBeenCalledWith(expect.stringContaining("no text engine"));
});
