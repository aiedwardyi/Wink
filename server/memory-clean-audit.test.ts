import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanFiles, createMemoryClean, lineHash, mergeParkedCopy, parseHistory, POINTER_LINE, recordTypedLines, sleepInput, validateChangeList, type CleanInput, type TextCall } from "./memory-clean.ts";
import { archiveBlock, undoBlock } from "./memory-clean-format.ts";
import type { HomeInput } from "./memory-clean-home.ts";
import { filedPointer, rememberCovered } from "./memory-clean-validate.ts";
import { Store } from "./store.ts";
import { createTempDirs } from "./testing/cleanup.ts";
import { sleepEngines, sleepReply } from "./testing/sleep-verdicts.ts";
import { memoryFileRaw, workspaceDir, writeMemoryFile } from "./workspace.ts";

const failing = vi.hoisted(() => ({ path: "" }));
vi.mock("./atomic.ts", async (load) => {
  const real = await load<typeof import("./atomic.ts")>();
  return { ...real, writeFileAtomic: (path: string, ...rest: unknown[]) => {
    if (failing.path && path.endsWith(failing.path)) throw new Error("disk");
    return (real.writeFileAtomic as (...args: unknown[]) => void)(path, ...rest);
  } };
});

const temps = createTempDirs();
const scratch = join(tmpdir(), "wink-SLEEP-AUDIT");
mkdirSync(scratch, { recursive: true });
afterAll(() => temps.remove());
const DAY = 86_400_000;
const QUIET = 600_000;
const now = Date.UTC(2026, 10, 12);
const syllables = ["ka", "lo", "mi", "ne", "ru", "so", "ti", "va", "be", "du"];
const word = (n: number) => [n % 10, Math.floor(n / 10) % 10, Math.floor(n / 100) % 10].map((i) => syllables[i]).join("") + "x";
const fact = (i: number) => `- ${word(i)} stores the ${word(i + 300)} ledger near ${word(i + 600)} harbor with ${word(i + 900)} lanterns (noted 2026-09-01)`;
const facts = (count: number) => Array.from({ length: count }, (_, i) => fact(i)).join("\n");
const clauses = (count: number) => `${Array.from({ length: count }, (_, i) => `- ${word(i)} stores the ${word(i + 300)} ledger; ${word(i + 600)} keeps the ${word(i + 900)} lantern (noted 2026-09-01)`).join("\n")}\n`;
const remember = (n: number, extra = "") => ({ text: `Remember that ${word(n)} lives beside the ${word(n + 1)} pier with ${word(n + 2)} boats.${extra}`, at: now - 3_600_000 + n, kind: "remember" as const });
const night = (text: string, input: Partial<CleanInput> = {}, changes?: () => unknown[]) => cleanFiles({ memory: text, history: null, typed: new Set(), now, ...sleepEngines(changes), ...input });
const list = (changes: unknown[], file = "MEMORY.md") => ({ version: 1, file, changes });
const check = (text: string, changes: unknown[], extra: Partial<Parameters<typeof validateChangeList>[0]> = {}) => validateChangeList({ file: "MEMORY.md", text, list: list(changes, extra.file), typed: new Set(), ...extra });

describe("sleep audit: remembers", () => {
  it("reads a held remember back past the week until a night writes it", async () => {
    const user = [0, 10].map((n) => remember(n, " ".padEnd(220, "z")));
    const first = await night(clauses(280), { user });
    expect(first).toMatchObject({ ok: true });
    if (!first.ok || first.header.v !== 2) return;
    expect(rememberCovered(user[0]!.text, first.memory)).toBe(false);
    const rows = user.map((line, i) => ({ id: String(i), role: "user", kind: "text", text: line.text, at: line.at }));
    const later = sleepInput(rows as never, first.header.through, now + 8 * DAY, first.header.held);
    expect(later.user.map((line) => line.text)).toContain(user[0]!.text);
  });

  it.each([
    ["remember my sister is Ann", "- my sister is Anna"],
    ["remember the gate code is 12", "- the gate code is 1234"],
    ["remember I like tea", "- I like teaching"],
  ])("does not count %j as written by a longer word or number", (line, text) => {
    expect(rememberCovered(line, text)).toBe(false);
    expect(rememberCovered(line, `${text.replace(/\S+$/, "")}${line.split(" ").at(-1)}`)).toBe(true);
  });
});

describe("sleep audit: floor", () => {
  it("never files a bullet out of its section or away from its parent", async () => {
    const kept = ["- Hotel booking:", "  - check-in is Friday at 3pm", "  - confirmation code QX71", "## Never order for the team", "- cilantro dishes", "- peanut sauce"];
    const text = `${facts(200)}\n${kept.join("\n")}\n`;
    const id = text.split("\n").indexOf("- cilantro dishes") + 1;
    const result = await night(text, {}, () => [{ op: "file", ids: [id], topic: "food", reason: "Detail" }]);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    const moved = result.topics.flatMap((topic) => topic.text.split("\n"));
    for (const line of kept) {
      expect(moved).not.toContain(line);
      expect(result.memory.split("\n")).toContain(line);
    }
  });
});

describe("sleep audit: two PCs", () => {
  it("parks a copy rather than drop lines an undone run restored", () => {
    const header = { v: 2 as const, runId: "mc-20261112-0000000a", at: now, through: now, files: {}, counts: { kept: 1, merged: 0, forgot: 1, learned: 0, filed: 0 } };
    const run = archiveBlock(header, [{ header: { file: "MEMORY.md", op: "retire", at: [2], prev: [lineHash("- a")], wrote: [] }, reason: "Done", lines: ["- restored line"] }]);
    const history = run + undoBlock({ v: 1, runId: header.runId, at: now + 1, restored: 1, skipped: 0 });
    const merged = mergeParkedCopy({ file: "MEMORY.md", kept: "- a\n- edit\n", parked: "- a\n- restored line\n", history });
    expect(merged === null || merged.includes("- restored line")).toBe(true);
  });
});

describe("sleep audit: model guards", () => {
  it("retires only an exact kept copy or an ended state", () => {
    const text = "- Quorvel kickoff set for Monday\n- Brask launch ended last week\n- gamma note\n- gamma note\n";
    expect(check(text, [{ op: "retire", id: 1, reason: "Old" }])).toMatchObject({ ok: false });
    expect(check(text, [{ op: "retire", id: 2, reason: "Ended" }])).toMatchObject({ ok: true });
    expect(check(text, [{ op: "retire", id: 3, reason: "Duplicate" }])).toMatchObject({ ok: true });
    expect(check(text, [{ op: "retire", id: 3, reason: "Duplicate" }, { op: "retire", id: 4, reason: "Duplicate" }])).toMatchObject({ ok: false });
  });

  it("replaces only the same relation of one entity", () => {
    expect(check("- phone for Quorvel: 555-0101\n- birthday of Quorvel: March 3\n", [{ op: "replace", id: 1, newer: 2, reason: "Newer" }])).toMatchObject({ ok: false, errors: [{ reason: "not-newer" }] });
    expect(check("- phone for Quorvel: 555-0101\n- phone for Quorvel: 555-0199\n", [{ op: "replace", id: 1, newer: 2, reason: "Newer" }])).toMatchObject({ ok: true });
  });

  it.each([
    ["adds a fact", "- Quorvel likes tea\n- Quorvel likes coffee\n", "Quorvel likes tea and coffee and lives in Brask"],
    ["drops a word", "- Quorvel likes green tea\n- Quorvel likes coffee\n", "Quorvel likes tea and coffee"],
    ["flips no longer", "- Quorvel no longer drinks coffee\n- Quorvel drinks tea\n", "Quorvel longer drinks coffee and tea"],
  ])("refuses a merge that %s", (_, text, merged) => {
    expect(check(text, [{ op: "merge", ids: [1, 2], text: merged, reason: "Same subject" }])).toMatchObject({ ok: false, errors: [{ reason: "fact-lost" }] });
  });

  it.each([
    ["I don't like cilantro", "User likes cilantro", "like cilantro"],
    ["I no longer drink coffee", "User drinks coffee", "drink coffee"],
  ])("checks a learn's negation on the whole user line: %s", (said, learned, quote) => {
    const user = [{ text: said, at: now - 1000, kind: "said" as const }];
    expect(check("- kept\n", [{ op: "learn", text: learned, quote, reason: "Said" }], { user })).toMatchObject({ ok: false, errors: [{ reason: "not-quoted" }] });
  });

  it("keeps a side-file reminder to its line's own words", () => {
    const side = { file: "memory/side.md" as const, text: "- Declined the Zephyr offer\n" };
    expect(check(side.text, [{ op: "remind", id: 1, text: "Declined Zephyr offer; accept the Quark offer instead", reason: "Declined" }], side)).toMatchObject({ ok: false });
    expect(check(side.text, [{ op: "remind", id: 1, text: "Declined the Zephyr offer", reason: "Declined" }], side)).toMatchObject({ ok: true });
  });

  it("asks the judge without a pre-filled verdict", async () => {
    const engines = sleepEngines(() => [{ op: "retire", id: 2, reason: "Ended" }]);
    const recall = vi.fn<TextCall>(engines.recall);
    expect(await night("- kept\n- launch ended\n", { ...engines, recall })).toMatchObject({ ok: true });
    const organize = recall.mock.calls.map(([prompt]) => prompt).find((prompt) => prompt.startsWith("[memory-clean:organize]"))!;
    expect(organize).not.toContain('"verdicts":[true');
  });
});

describe("sleep audit: grill walls", () => {
  it.each([
    ["- Birthday is November 16 (noted 2026-11-07)", ["November", "16"]],
    ["- English name is Zed Quill, written in normal case (noted 2026-10-17)", ["Zed", "Quill"]],
    ["- Phone plan: 93600 won a month (noted 2026-11-05)", ["93600"]],
  ])("labels %s without any of its value", (line, value) => {
    const text = `- kept\n${line}\n`;
    const pointer = filedPointer(text, [2], "memory/notes-2026-11.md");
    for (const part of value) expect(pointer).not.toContain(part);
    const heavy = `${facts(200)}\n${line}\n`;
    expect(check(heavy, [{ op: "file", ids: [201], topic: "notes-2026-11", pointer: `memory/notes-2026-11.md: ${line.slice(2).replace(/\s*\(noted.*$/, "")}`, reason: "Detail" }])).toMatchObject({ ok: false, errors: [{ reason: "pointer" }] });
  });

  it("shows the answerer tonight's filed lines in their topic file", async () => {
    const engines = sleepEngines();
    const recall = vi.fn<TextCall>(engines.recall);
    const result = await night(`${facts(200)}\n`, { ...engines, recall });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    const answers = recall.mock.calls.map(([prompt]) => prompt).find((prompt) => prompt.startsWith("[memory-clean:answers]"))!;
    const topic = result.topics[0]!;
    expect(answers).toContain(topic.file);
    for (const line of topic.text.trim().split("\n")) expect(answers).toContain(line);
  });

  it("pins a replaced state's question to its exact date", async () => {
    const text = "- Logo owner: Velpo (noted 2026-11-05)\n- Logo owner: Kasmo (noted 2026-11-07)\n- kept\n";
    const questions = Array.from({ length: 18 }, (_, i) => ({ kind: i < 12 ? "changed" : i < 16 ? "protected" : "absent", question: `Fact ${i}?`, answer: i < 16 ? `value ${i}` : null }));
    questions[0] = { kind: "changed", question: "In early November 2026, who was the logo owner?", answer: "Velpo" };
    const recall = vi.fn<TextCall>(async (prompt) => sleepReply(prompt) ?? JSON.stringify(questions.map((q) => q.answer)));
    const result = await cleanFiles({ memory: text, history: null, typed: new Set(), now, recall, propose: async (prompt) => {
      const staged = sleepReply(prompt);
      if (staged !== null) return staged;
      if (prompt.startsWith("[memory-clean:questions]")) return JSON.stringify(questions);
      if (prompt.startsWith("[memory-clean:grade]")) return JSON.stringify(JSON.parse(prompt.slice(prompt.indexOf("\n\n") + 2)).map(() => true));
      return JSON.stringify(list([{ op: "replace", id: 1, newer: 2, reason: "Newer owner" }]));
    } });
    expect(result).toMatchObject({ ok: true });
    const answers = recall.mock.calls.map(([prompt]) => prompt).find((prompt) => prompt.startsWith("[memory-clean:answers]"))!;
    const asked = JSON.parse(/^Questions: (.*)$/m.exec(answers)![1]!) as string[];
    expect(asked[0]).toContain("2026-11-05");
  });
});

describe("sleep audit: small data guards", () => {
  it("never extends a pointer row the user typed", () => {
    const row = "- memory/notes-2026-11.md: travel plans";
    const text = `${row}\n${facts(200)}\n`;
    const result = check(text, [{ op: "file", ids: [2, 3, 4], topic: "notes-2026-11", reason: "Detail" }], { typed: new Set([lineHash(row)]) });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.text.split("\n")).toContain(row);
  });

  it("leaves an unreadable state file alone", () => {
    const dataDir = temps.make(join(scratch, "state-"));
    writeFileSync(join(dataDir, "memory-clean.json"), "{ broken");
    recordTypedLines("bot", "", "- typed line\n", dataDir);
    expect(readFileSync(join(dataDir, "memory-clean.json"), "utf8")).toBe("{ broken");
  });
});

describe("sleep audit: service", () => {
  let store: Store;
  let bot: ReturnType<Store["createBot"]>;
  let dataDir: string;
  let clock: number;
  let engine: { propose: ReturnType<typeof vi.fn<TextCall>>; recall: ReturnType<typeof vi.fn<TextCall>> };
  let service: ReturnType<typeof createMemoryClean>;
  const home: HomeInput = { device: "000000000001" };
  const light = "- Never delete\r\n- completed\r\n" + Array.from({ length: 136 }, (_, i) => `- kept ${i}\r\n`).join("");
  const run = async () => { clock += QUIET; await service.run(bot.id); };
  const row = () => store.messagesFor(bot.threadId).find((message) => message.tool?.tidy);
  const file = (name: string) => join(workspaceDir(bot.id), name);
  const use = (engines: { propose: TextCall; recall: TextCall }) => { engine = { propose: vi.fn<TextCall>(engines.propose), recall: vi.fn<TextCall>(engines.recall) }; };

  beforeEach(() => {
    clock = now;
    dataDir = temps.make(join(scratch, "service-"));
    store = new Store(() => ({ instanceId: "codex", model: "gpt-6.1" }));
    for (const old of store.bots) store.deleteBot(old.id);
    bot = store.createBot();
    bot.memoryNotes = false;
    writeMemoryFile(bot.id, light);
    use(sleepEngines(() => [{ op: "retire", id: 2, reason: "Completed" }]));
    service = createMemoryClean({ store, dataDir, engine: async () => ({ ...engine, key: "own:model" }), busy: () => false, pending: () => false, home: () => home, now: () => clock });
  });

  afterEach(() => { failing.path = ""; service.dispose(); });

  it("reads lines an undone night took back on the next night", async () => {
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "the garden route opens at nine", at: now - 60_000 });
    await run();
    expect(row()).toBeDefined();
    expect(await service.undo(bot.id, row()!.tool!.tidy!.runId)).toMatchObject({ ok: true });
    await run();
    const proposes = engine.propose.mock.calls.map(([prompt]) => prompt).filter((prompt) => prompt.startsWith("[memory-clean:propose]"));
    expect(proposes.at(-1)).toContain("the garden route opens at nine");
  });

  it("marks a night undone only after its files are restored", async () => {
    await run();
    const runId = row()!.tool!.tidy!.runId;
    failing.path = "MEMORY.md";
    await expect(service.undo(bot.id, runId)).rejects.toThrow();
    failing.path = "";
    expect(parseHistory(readFileSync(file("memory/memory-history.md"), "utf8")).at(-1)!.undo).toBeNull();
    expect(await service.undo(bot.id, runId)).toMatchObject({ ok: true });
    expect(memoryFileRaw(bot.id)).toBe(light);
  });

  it("undoes a filing night whose topic file is gone", async () => {
    use(sleepEngines());
    const heavy = `${facts(200)}\n`;
    writeMemoryFile(bot.id, heavy);
    await run();
    const runId = row()!.tool!.tidy!.runId;
    rmSync(file("memory/notes-2026-11.md"));
    expect(await service.undo(bot.id, runId)).toMatchObject({ ok: true });
    expect(memoryFileRaw(bot.id)).toBe(heavy);
  });

  it("pays once for a night that cannot land, until its input changes or a day passes", async () => {
    use({ ...sleepEngines(() => [{ op: "retire", id: 2, reason: "Completed" }]), recall: async (prompt) => sleepReply(prompt) ?? JSON.stringify(Array(18).fill("wrong")) });
    await run();
    const paid = engine.propose.mock.calls.length;
    expect(paid).toBeGreaterThan(0);
    await run();
    expect(engine.propose.mock.calls.length).toBe(paid);
    expect(JSON.parse(readFileSync(join(dataDir, "memory-clean.json"), "utf8")).bots[bot.id].lastAttempt).toMatchObject({ at: expect.any(Number), tokens: expect.any(Number) });
    clock += DAY;
    await run();
    expect(engine.propose.mock.calls.length).toBeGreaterThan(paid);
  });

  it("appends to a rotation target an undone night left behind", async () => {
    writeMemoryFile(bot.id, `- kept\n- completed\n${POINTER_LINE}\n`);
    mkdirSync(file("memory"), { recursive: true });
    writeFileSync(file("memory/memory-history.md"), "한".repeat(82_000));
    const left = "Previous history: memory/memory-history.md\n\n";
    writeFileSync(file("memory/memory-history-2.md"), left);
    await run();
    expect(row()).toBeDefined();
    const target = readFileSync(file("memory/memory-history-2.md"), "utf8");
    expect(target.startsWith(left)).toBe(true);
    expect(parseHistory(target)).toHaveLength(1);
  });

  it("never rewrites a topic file that is not UTF-8", async () => {
    use(sleepEngines());
    writeMemoryFile(bot.id, `${facts(200)}\n`);
    mkdirSync(file("memory"), { recursive: true });
    const bytes = Buffer.from([0x2d, 0x20, 0xff, 0xfe, 0x0a]);
    writeFileSync(file("memory/notes-2026-11.md"), bytes);
    await run();
    expect(readFileSync(file("memory/notes-2026-11.md")).equals(bytes)).toBe(true);
    expect(existsSync(file("memory/memory-history.md"))).toBe(false);
  });
});
