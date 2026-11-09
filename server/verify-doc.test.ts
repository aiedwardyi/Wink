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
let fix: ReturnType<typeof vi.fn<(botId: string, threadId: string, prompt: string) => Promise<boolean>>>;
let doc: ReturnType<typeof createVerifyDoc>;
const start = (paths: string[], humanId = "human"): DocStart => ({ botId: "bot", threadId: "thread", roots: [root], paths, humanId });
const slip = (...quotes: [string, string][]) => JSON.stringify({ findings: quotes.map(([quote, fix]) => ({ kind: "spelling", quote, fix, note: "맞춤법" })), names: [], dates: [] });
const write = (edits: Record<number, string>) => writeFile(join(root, "script.md"), LINES.map((line, i) => edits[i] ?? line).join("\n"));
const fixEnded = () => doc.ended({ botId: "bot", threadId: "thread", startedAt: Date.now() });
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
  fix = vi.fn().mockResolvedValue(true);
  doc = createVerifyDoc({ store: store as never, instanceFor: () => engine, busy: () => busy, fix, deviceId: () => "device", broadcastPatch: vi.fn(), log, quietMs: 20 });
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
  await write({ 49: "계약서는 다음 주에 보내 드리면 되요." });
  generate.mockResolvedValueOnce(slip(["되요", "돼요"]));
  doc.schedule(start(["script.md"], "first"));
  await done();
  expect(cards()[0]!.doc).toMatchObject({ by: { spelling: 1 }, findingTotal: 1, findings: [{ kind: "spelling", line: 50, page: 2, quote: "되요", fix: "돼요", note: "맞춤법" }] });
  await write({ 49: "계약서는 다음 주에 보내 드리면 돼요." });
  doc.schedule(start(["script.md"], "second"));
  await vi.waitFor(() => expect(cards()).toHaveLength(2));
  await done();
  expect(cards()[1]).toMatchObject({ fixed: 1, doc: { findingTotal: 0 } });
});

it("hands findings to the bot's fix turn, then rechecks the fixed file on the same card", async () => {
  await write({ 49: "계약서는 다음 주에 보내 드리면 되요." });
  generate.mockResolvedValueOnce(slip(["되요", "돼요"]));
  doc.schedule(start(["script.md"]));
  await vi.waitFor(() => expect(fix).toHaveBeenCalledOnce());
  const [botId, threadId, prompt] = fix.mock.calls[0]!;
  expect([botId, threadId]).toEqual(["bot", "thread"]);
  expect(prompt).toContain(join(root, "script.md"));
  expect(prompt).toContain(`p.2 line 50 (spelling): "되요" → "돼요" (맞춤법)`);
  expect(cards()[0]).toMatchObject({ status: "completed", doc: { fixing: true, findingTotal: 1 } });
  doc.ended({ botId: "bot", threadId: "thread", startedAt: 0 });
  await delay(60);
  expect(generate).toHaveBeenCalledOnce();
  await write({ 49: "계약서는 다음 주에 보내 드리면 돼요." });
  fixEnded();
  await vi.waitFor(() => expect(cards()[0]).toMatchObject({ status: "completed", fixed: 1, doc: { findingTotal: 0, fixedFindings: [{ quote: "되요", fix: "돼요" }] } }));
  expect(cards()).toHaveLength(1);
  expect(cards()[0]!.doc!.fixing).toBeUndefined();
  expect(generate).toHaveBeenCalledTimes(2);
  expect(fix).toHaveBeenCalledOnce();
});

it("waits until the bot is free to start the fix turn, and retries a busy start", async () => {
  await write({ 49: "계약서는 다음 주에 보내 드리면 되요." });
  generate.mockImplementationOnce(async () => { busy = true; return slip(["되요", "돼요"]); });
  fix.mockResolvedValueOnce(false);
  doc.schedule(start(["script.md"]));
  await done();
  await delay(80);
  expect(fix).not.toHaveBeenCalled();
  expect(cards()[0]!.doc!.fixing).toBe(true);
  busy = false;
  await vi.waitFor(() => expect(fix).toHaveBeenCalledTimes(2));
});

it("drops bot is fixing when the fix turn changed nothing", async () => {
  await write({ 49: "계약서는 다음 주에 보내 드리면 되요." });
  generate.mockResolvedValueOnce(slip(["되요", "돼요"]));
  doc.schedule(start(["script.md"]));
  await vi.waitFor(() => expect(fix).toHaveBeenCalledOnce());
  fixEnded();
  await vi.waitFor(() => expect(cards()[0]!.doc!.fixing).toBeUndefined());
  expect(cards()[0]).toMatchObject({ status: "completed", doc: { findingTotal: 1 } });
  expect(cards()[0]!.fixed).toBeUndefined();
  expect(generate).toHaveBeenCalledOnce();
});

it("never hands back a finding the bot left", async () => {
  await write({ 10: "회의는 오후 세시에 시작 했다.", 49: "계약서는 다음 주에 보내 드리면 되요." });
  generate.mockResolvedValueOnce(slip(["시작 했다", "시작했다"], ["되요", "돼요"]));
  doc.schedule(start(["script.md"]));
  await vi.waitFor(() => expect(fix).toHaveBeenCalledOnce());
  await write({ 10: "회의는 오후 세시에 시작 했다." });
  generate.mockResolvedValueOnce(slip(["시작 했다", "시작했다"]));
  fixEnded();
  await vi.waitFor(() => expect(cards()[0]).toMatchObject({ status: "completed", fixed: 1, doc: { findingTotal: 1 } }));
  await delay(60);
  expect(fix).toHaveBeenCalledOnce();
  expect(cards()[0]!.doc!.fixing).toBeUndefined();
});

it("never counts a finding as fixed while its words are still in the document", async () => {
  await write({ 10: "회의는 오후 세시에 시작 했다.", 49: "계약서는 다음 주에 보내 드리면 되요." });
  generate.mockResolvedValueOnce(slip(["시작 했다", "시작했다"], ["되요", "돼요"]));
  doc.schedule(start(["script.md"]));
  await vi.waitFor(() => expect(fix).toHaveBeenCalledOnce());
  await write({ 10: "회의는 오후 세시에 시작 했다." });
  fixEnded();
  await vi.waitFor(() => expect(cards()[0]).toMatchObject({ status: "completed", fixed: 1, doc: { findingTotal: 1, findings: [{ quote: "시작 했다" }], fixedFindings: [{ quote: "되요" }] } }));
});

it("stops after two fix rounds for one user turn, even when each fix leaves a new slip", async () => {
  const rounds: [Record<number, string>, string, string][] = [
    [{ 49: "계약서는 다음 주에 보내 드리면 되요." }, "되요", "돼요"],
    [{ 20: "자료를 검토 했다." }, "검토 했다", "검토했다"],
    [{ 30: "다음주에 다시 만나요." }, "다음주", "다음 주"],
  ];
  await write(rounds[0]![0]);
  generate.mockResolvedValueOnce(slip([rounds[0]![1], rounds[0]![2]]));
  doc.schedule(start(["script.md"]));
  for (const [i, [edits, quote, to]] of rounds.slice(1).entries()) {
    await vi.waitFor(() => expect(fix).toHaveBeenCalledTimes(i + 1));
    await write(edits);
    generate.mockResolvedValueOnce(slip([quote, to]));
    fixEnded();
  }
  await vi.waitFor(() => expect(cards()[0]).toMatchObject({ status: "completed", fixed: 2, doc: { findingTotal: 1 } }));
  await delay(80);
  expect(fix).toHaveBeenCalledTimes(2);
  expect(cards()).toHaveLength(1);
  expect(cards()[0]!.doc!.fixing).toBeUndefined();
});

it("counts nothing fixed and checks again after the name and date comparison failed", async () => {
  const long = Array.from({ length: 900 }, (_, i) => `${i + 1}번째 문단입니다. 오늘 회의에서 정한 내용을 차례로 적어 둡니다.`);
  long[5] = "김민서 씨가 계약서를 보냈다.";
  await writeFile(join(root, "script.md"), long.join("\n"));
  let merges = 0;
  generate.mockImplementation(async prompt => {
    if (!prompt.startsWith("These names and dates")) return JSON.stringify({ findings: [], names: [], dates: [{ date: "2024. 3. 15.", what: "contract signed" }, { date: "2024. 6. 10.", what: "reminder sent" }] });
    if (++merges > 1) throw new Error("timed out");
    return JSON.stringify({ findings: [{ kind: "names", quote: "김민서", fix: "김민수", note: "two spellings" }] });
  });
  doc.schedule(start(["script.md"]));
  await done();
  expect(cards()[0]!.doc!.findingTotal).toBe(1);
  long[800] += " 덧붙임.";
  await writeFile(join(root, "script.md"), long.join("\n"));
  doc.schedule(start(["script.md"], "second"));
  await vi.waitFor(() => expect(cards()).toHaveLength(2));
  await done();
  expect(cards()[1]!.fixed).toBeUndefined();
  doc.schedule(start(["script.md"], "third"));
  await vi.waitFor(() => expect(cards()).toHaveLength(3));
});

it("handles tens of thousands of findings in linear time", async () => {
  await writeFile(join(root, "script.md"), "제2조\n".repeat(40_000));
  const started = performance.now();
  doc.schedule(start(["script.md"]));
  await done();
  expect(cards()[0]!.doc!.findingTotal).toBeGreaterThan(30_000);
  expect(performance.now() - started).toBeLessThan(3_000);
});

it("shows a name slip only after the comparison call confirms it", async () => {
  const lines = [...LINES];
  for (const i of [3, 9, 15, 21, 27, 33]) lines[i] = "준호: 가자, 늦겠어.";
  lines[40] = "준오: 나중에 하자.";
  await writeFile(join(root, "script.md"), lines.join("\n"));
  const merges: string[] = [];
  generate.mockImplementation(async prompt => {
    if (!prompt.startsWith("These names and dates")) return JSON.stringify({ findings: [], names: ["준호", "준오"], dates: [] });
    merges.push(prompt);
    return JSON.stringify({ findings: merges.length > 1 ? [{ kind: "names", quote: "준오", fix: "준호", note: "typo" }] : [] });
  });
  doc.schedule(start(["script.md"]));
  await done();
  expect(merges[0]).toContain("준오: 나중에 하자.");
  expect(cards()[0]!.doc!.findingTotal).toBe(0);
  await writeFile(join(root, "script.md"), [...lines, "덧붙인 줄이에요."].join("\n"));
  doc.schedule(start(["script.md"]));
  await vi.waitFor(() => expect(cards()).toHaveLength(2));
  await done();
  expect(cards()[1]!.doc!.findings).toEqual([{ kind: "names", line: 41, page: 1, quote: "준오", fix: "준호", note: "다른 곳은 준호 (6번)" }]);
});

it("keeps a date slip the comparison confirms, whatever kind or order it writes", async () => {
  const lines = [...LINES];
  lines[10] = "계약은 2024. 3. 15. 체결되었다.";
  lines[30] = "2024. 3. 25. 체결된 계약에 따라 지급하라.";
  await writeFile(join(root, "script.md"), lines.join("\n"));
  generate.mockImplementation(async prompt => JSON.stringify(prompt.startsWith("These names and dates")
    ? { findings: [{ kind: "events", quote: "2024. 3. 15.", fix: "2024. 3. 25.", note: "same contract" }] }
    : { findings: [], names: [], dates: [{ date: "2024. 3. 15.", what: "supply contract signed" }, { date: "2024. 3. 25.", what: "supply contract signed" }] }));
  doc.schedule(start(["script.md"]));
  await done();
  expect(cards()[0]!.doc!.findings).toEqual([{ kind: "names", line: 31, page: 1, quote: "2024. 3. 25.", fix: "2024. 3. 15.", note: "같은 일, 다른 날짜" }]);
});

it("shows names and dates as not checked when the comparison reply is not JSON, and checks again", async () => {
  const long = Array.from({ length: 900 }, (_, i) => `${i + 1}번째 문단입니다. 오늘 회의에서 정한 내용을 차례로 적어 둡니다.`);
  await writeFile(join(root, "script.md"), long.join("\n"));
  generate.mockImplementation(async prompt => prompt.startsWith("These names and dates") ? "I could not compare these." : JSON.stringify({ findings: [], names: [], dates: [{ date: "2024. 3. 15.", what: "contract signed" }, { date: "2024. 6. 10.", what: "reminder sent" }] }));
  doc.schedule(start(["script.md"]));
  await done();
  expect(cards()[0]!.doc!.uncompared).toBe(true);
  doc.schedule(start(["script.md"]));
  await vi.waitFor(() => expect(cards()).toHaveLength(2));
});

it("keeps secrets out of the replay, like the card", async () => {
  const lines = [...LINES];
  lines[9] = "export DATABASE_PASSWORD=hunter2hunter2";
  await writeFile(join(root, "script.md"), lines.join("\n"));
  let reply!: (text: string) => void;
  generate.mockImplementationOnce(() => new Promise<string>(resolve => { reply = resolve; }));
  doc.schedule(start(["script.md"]));
  await vi.waitFor(() => expect(cards()[0]?.status).toBe("running"));
  const run = doc.run(cards()[0]!.runId)!;
  reply(JSON.stringify({ findings: [{ kind: "spelling", quote: "DATABASE_PASSWORD=hunter2hunter2", fix: "DATABASE_PASSWORD=hunter2hunter3" }], names: [], dates: [] }));
  await done();
  const replay = run.recording.file().toString();
  expect(replay).toContain("doc-finding");
  expect(replay).not.toContain("hunter2");
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
