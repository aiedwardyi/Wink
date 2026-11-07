import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CleanInput, TextCall } from "./memory-clean.ts";
import type { HomeInput } from "./memory-clean-home.ts";
import { Store } from "./store.ts";
import { createTempDirs } from "./testing/cleanup.ts";
import { withSystemChanges } from "./turn-context.ts";
import { memoryFileRaw, workspaceDir, writeMemoryFile } from "./workspace.ts";

const sabotage = vi.hoisted(() => ({ undo: false }));
vi.mock("./memory-clean-undo.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./memory-clean-undo.ts")>();
  return { ...real, undoText: (...args: Parameters<typeof real.undoText>) => {
    const result = real.undoText(...args);
    return sabotage.undo ? { ...result, text: `${result.text}x` } : result;
  } };
});

const temps = createTempDirs();
const scratch = join(tmpdir(), "wink-CLEAN-CORE");
mkdirSync(scratch, { recursive: true });
afterAll(() => temps.remove());
const load = () => import("./memory-clean.ts");
const list = (changes: unknown[], file = "MEMORY.md") => ({ version: 1, file, changes });
const retire = (id: number) => ({ op: "retire", id, reason: "Completed" });
const validate = async (text: string, changes: unknown[], file: "MEMORY.md" | `memory/${string}.md` = "MEMORY.md", typed = new Set<string>()) =>
  (await load()).validateChangeList({ text, list: list(changes, file), file, typed });

describe("change list validation", () => {
  it.each(["The", "Uploads", "Monthly", "Post"])("allows rewording sentence-initial %s while preserving facts", async (word) => {
    const text = `- ${word} task finished. ${word} work ended.\n- other work ended\n- met Eddie at C:\\repo with 792 TASKID\n- Eddie finished\n- iPhone shipped\n- V2 shipped\n- ALLCAPS shipped`;
    const merge = (ids: number[], text: string) => [{ op: "merge", ids, text, reason: "Same subject" }];
    expect(await validate(text, merge([1, 2], "- task and other work finished"))).toMatchObject({ ok: true });
    for (const [ids, value] of [[[3, 4], "- met at C:\\repo with 792 TASKID"], [[3, 4], "- met Eddie with 792 TASKID"], [[3, 4], "- met Eddie at C:\\repo with TASKID"], [[3, 4], "- met Eddie at C:\\repo with 792"], [[4, 5], "- Eddie shipped"], [[4, 6], "- Eddie shipped"], [[4, 7], "- Eddie shipped"]] as Array<[number[], string]>) {
      expect(await validate(text, merge(ids, value))).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ reason: "fact-lost" })]) });
    }
    expect(await validate(text, merge([3, 4], "- Eddie finished; met Eddie at C:\\repo with 792 TASKID"))).toMatchObject({ ok: true });
    expect(await validate(text + `\n- tracked ${word} elsewhere`, merge([1, 2], "- task and other work finished"))).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ reason: "fact-lost" })]) });
  });

  it.each([
    ["shape", "- done", { version: 2 }, "MEMORY.md"],
    ["unknown-id", "- done\n\n", list([retire(2)]), "MEMORY.md"],
    ["reused-id", "- done", list([retire(1), retire(1)]), "MEMORY.md"],
    ["protected", "- Never publish", list([retire(1)]), "MEMORY.md"],
    ["fact-lost", "- Eddie has 9 cats\n- Eddie has 2 dogs", list([{ op: "merge", ids: [1, 2], text: "- Eddie has cats", reason: "Duplicate" }]), "MEMORY.md"],
    ["too-long", "- done", list([{ ...retire(1), reason: "x".repeat(121) }]), "MEMORY.md"],
    ["not-newer", "- headcount 9 (noted 2026-11-04)\n- headcount 8 (noted 2026-10-01)", list([{ op: "replace", id: 1, newer: 2, reason: "Newer" }]), "MEMORY.md"],
    ["not-verbatim", "- old red green blue", list([{ op: "split", id: 1, keep: ["blue", "red"], reason: "Done" }], "memory/topic.md"), "memory/topic.md"],
    ["op-not-allowed", "- done", list([{ op: "split", id: 1, keep: ["done"], reason: "Done" }]), "MEMORY.md"],
    ["pointer", "- memory/topic.md: details", list([retire(1)]), "MEMORY.md"],
    ["cap-lines", Array.from({ length: 41 }, () => "- done").join("\n"), list(Array.from({ length: 41 }, (_, i) => retire(i + 1))), "MEMORY.md"],
    ["cap-chars", `- ${"x".repeat(8001)}\n- kept`, list([retire(1)]), "MEMORY.md"],
    ["budget", `- done\n${"x".repeat(24001)}`, list([retire(1)]), "MEMORY.md"],
  ])("rejects %s", async (reason, text, proposal, file) => {
    const result = (await load()).validateChangeList({ text: text as string, list: proposal, file: file as "MEMORY.md", typed: new Set() });
    expect(result).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ reason })]) });
  });

  it.each([
    "- Correction: check evidence", "- Lesson: verify first", "- Always check", "- Never deploy", "- Don't delete",
    "- Preference: short replies", "- 항상 확인", "- 절대 삭제", "- 하지 마", "- Declined: panels", "- 거절: 패널",
    "## Pinned\n- keep this", "## 고정\n- keep this", "- keep this (pinned)",
  ])("keeps protected %s", async (text) => {
    expect(await validate(text, [retire(text.split("\n").length)])).toMatchObject({ ok: false });
  });

  it("protects typed hashes and permits retiring only an exact protected duplicate", async () => {
    const { lineHash } = await load();
    expect(await validate("- typed", [retire(1)], "MEMORY.md", new Set([lineHash("- typed")]))).toMatchObject({ ok: false });
    expect(await validate("- Never delete\n- Never delete", [retire(1)])).toMatchObject({ ok: true, text: "- Never delete" });
    expect(await validate("- Never delete\n- Never delete", [retire(1), retire(2)])).toMatchObject({ ok: false });
  });

  it("keeps numbers, dates, paths, names and quoted strings in a merge", async () => {
    const { factTokens } = await load();
    const text = '- met Eddie at C:\\repo on 2026-11-04\n- Eddie has 12 "red cats"';
    const merged = '- met Eddie at C:\\repo on 2026-11-04; Eddie has 12 "red cats"';
    expect(factTokens(text)).toEqual(expect.arrayContaining(["Eddie", "C:\\repo", "2026-11-04", "12", '"red cats"']));
    expect(await validate(text, [{ op: "merge", ids: [1, 2], text: merged, reason: "Same subject" }])).toMatchObject({ ok: true, text: merged });
  });

  it("uses inline dates before file position and allows protected newer lines", async () => {
    expect(await validate("- old 9\n- Always use 11", [{ op: "replace", id: 1, newer: 2, reason: "Current" }])).toMatchObject({ ok: true });
    expect(await validate("- new (noted 2026-11-04)\n- old (noted 2026-10-01)", [{ op: "replace", id: 2, newer: 1, reason: "Current" }])).toMatchObject({ ok: true });
  });

  it.each(["pending", "PARKED", "await", "awaits", "awaiting", "대기", "보류"])("protects %s from retire but allows replacement", async (marker) => {
    const text = `- task ${marker}\n- task completed`;
    expect(await validate(text, [retire(1)])).toMatchObject({ ok: false, errors: [{ reason: "protected", change: 0 }] });
    expect(await validate(text, [{ op: "replace", id: 1, newer: 2, reason: "Current" }])).toMatchObject({ ok: true, text: "- task completed" });
    expect(await validate(`${text}\n- task ${marker}`, [retire(1)])).toMatchObject({ ok: false, errors: [{ reason: "protected", change: 0 }] });
  });

  it("splits verbatim fragments and only reminds declined side lines", async () => {
    expect(await validate("- old red green blue", [{ op: "split", id: 1, keep: ["red", "blue"], reason: "Done" }], "memory/topic.md")).toMatchObject({ ok: true, text: "- red blue" });
    expect(await validate("- Declined: a long plan", [{ op: "remind", id: 1, text: "- Declined: plan", reason: "Keep reminder" }], "memory/topic.md")).toMatchObject({ ok: true });
    expect(await validate("- ordinary", [{ op: "remind", id: 1, text: "- short", reason: "Short" }], "memory/topic.md")).toMatchObject({ ok: false });
  });

  it("counts the pointer in the reminder and line caps", async () => {
    const { cleanFiles } = await load();
    const memory = Array.from({ length: 40 }, (_, i) => `- completed ${i}`).join("\n");
    const result = await cleanFiles({ memory, history: null, typed: new Set(), propose: async () => JSON.stringify(list(Array.from({ length: 40 }, (_, i) => retire(i + 1)))), recall: async () => "{}" });
    expect(result).toMatchObject({ ok: false, stage: "validate" });
    expect(withSystemChanges("", "x".repeat(8001), "", 8000)).toBeNull();
  });

  it.each(["before {}", "```json\n{}\n```", { version: 1, file: "../MEMORY.md", changes: [] }, list([{ op: "merge", ids: [1], text: "x", reason: "x" }])])("rejects malformed proposal %s", async (proposal) => {
    expect((await load()).validateChangeList({ file: "MEMORY.md", text: "- done", list: proposal, typed: new Set() })).toMatchObject({ ok: false });
  });
});

const quiz = Array.from({ length: 18 }, (_, i) => ({ kind: i < 12 ? "changed" : i < 16 ? "protected" : "absent", question: `Fact ${i}?`, answer: i < 16 ? `value ${i}` : null }));
const proposer = (changes: () => unknown[]) => vi.fn<TextCall>(async (prompt) => {
  if (prompt.startsWith("[memory-clean:questions]")) {
    const topic = /"filedTo":"([^"]+)"/.exec(prompt)?.[1];
    return JSON.stringify(quiz.map((q, i) => i === 0 && topic ? { ...q, file: topic, answer: topic } : q));
  }
  if (prompt.startsWith("[memory-clean:grade]")) return JSON.stringify(JSON.parse(prompt.slice(prompt.indexOf("\n\n") + 2)).map(() => true));
  return JSON.stringify(list(changes()));
});
const answerer = () => vi.fn<TextCall>(async (prompt) => {
  const topic = /^- (memory\/(?!memory-history)[a-z0-9-]+\.md):/m.exec(prompt)?.[1];
  return JSON.stringify(quiz.map((q, i) => i === 0 && topic ? topic : q.answer));
});
const night = (memory: string, changes: unknown[], extra: Partial<CleanInput> = {}): CleanInput =>
  ({ memory, history: null, typed: new Set(), now: Date.UTC(2026, 10, 7), propose: proposer(() => changes), recall: answerer(), ...extra });
const learn = (quote: string, text: string, lesson = false) => ({ op: "learn", text, quote, lesson, reason: "User said it" });
const said = (text: string, kind: "said" | "remember" | "correction" = "said", at = 150) => ({ text, at, kind });

describe("sleep", () => {
  it("learns a fact only when it quotes a user line from this night", async () => {
    const { cleanFiles, validateChangeList } = await load();
    const user = [said("Jun moved to Jeju in May")];
    const result = await cleanFiles(night("- kept\n", [learn("Jun moved to Jeju", "- Jun moved to Jeju in May")], { user, through: 150 }));
    expect(result).toMatchObject({ ok: true, header: { v: 2, through: 150, counts: { learned: 1 } } });
    expect(result.ok && result.memory.split("\n").slice(0, 2)).toEqual(["- kept", "- Jun moved to Jeju in May"]);
    const check = (changes: unknown[], lines = user) => validateChangeList({ file: "MEMORY.md", text: "- kept\n", typed: new Set(), user: lines, list: list(changes) });
    expect(check([learn("Jun moved to Jeju", "- Jun moved to Jeju in June")])).toMatchObject({ ok: false, errors: [{ reason: "not-quoted" }] });
    expect(check([learn("Mina lives in Busan", "- Mina lives in Busan")])).toMatchObject({ ok: false, errors: [{ reason: "not-quoted" }] });
    const { sleepInput } = await load();
    const rows = [{ id: "a", role: "user", kind: "text", text: "Mina lives in Busan", at: 50 }, { id: "b", role: "user", kind: "text", text: "Jun moved to Jeju in May", at: 150 }];
    const tonight = sleepInput(rows as never, 100, 200);
    expect(tonight).toEqual({ user: [said("Jun moved to Jeju in May")], through: 150 });
    expect(check([learn("Mina lives in Busan", "- Mina lives in Busan")], tonight.user)).toMatchObject({ ok: false, errors: [{ reason: "not-quoted" }] });
    expect(sleepInput(rows as never, null, 200 + 7 * 86_400_000).user).toEqual([]);
  });

  it("appends a missed remember line verbatim and owns it", async () => {
    const { cleanFiles, lineHash } = await load();
    const user = [said("Remember that Mom's birthday is March 3", "remember")];
    const result = await cleanFiles(night("- kept\n", [], { user }));
    expect(result).toMatchObject({ ok: true, owned: [lineHash("- Remember that Mom's birthday is March 3")], header: { counts: { kept: 1, learned: 1 } } });
    expect(result.ok && result.memory.split("\n")[1]).toBe("- Remember that Mom's birthday is March 3");
    const owned = await cleanFiles(night("- Mom's birthday is March 3\n", [{ op: "own", id: 1, quote: "Mom's birthday is March 3", reason: "Asked to remember" }], { user }));
    expect(owned).toMatchObject({ ok: true, owned: [lineHash("- Mom's birthday is March 3")], header: { counts: { kept: 1, learned: 0 } } });
    expect(owned.ok && owned.memory.split("\n")[0]).toBe("- Mom's birthday is March 3");
  });

  it("counts kept merged forgot and learned so old lines add up", async () => {
    const { cleanFiles, parseHistory } = await load();
    const memory = "- tea at 9\n- tea at 9 daily\n- shipped v1 done\n- headcount 8 (noted 2026-10-01)\n- headcount 9 (noted 2026-11-04)\n- kept line\n";
    const result = await cleanFiles(night(memory, [
      { op: "merge", ids: [1, 2], text: "- tea at 9 daily", reason: "Same subject" }, retire(3), { op: "replace", id: 4, newer: 5, reason: "Newer" },
      learn("tea with Jun", "- tea with Jun"),
    ], { user: [said("I had tea with Jun")] }));
    expect(result).toMatchObject({ ok: true, header: { v: 2, counts: { kept: 2, merged: 2, forgot: 2, learned: 1, filed: 0 } } });
    if (!result.ok || result.header.v !== 2) return;
    const { kept, merged, forgot } = result.header.counts;
    expect(kept + merged + forgot).toBe(memory.split("\n").filter(Boolean).length);
    expect(parseHistory(result.block)[0]!.header).toEqual(result.header);
    expect(parseHistory(historyBlock())[0]!.header).toMatchObject({ v: 1, moved: 1 });
  });

  describe("service", () => {
    let clock: number;
    let dataDir: string;
    let store: Store;
    let bot: ReturnType<Store["createBot"]>;
    let changes: unknown[];
    let service: ReturnType<Awaited<ReturnType<typeof load>>["createMemoryClean"]>;
    const detail = (i: number) => `- detail ${i} ${"x".repeat(280)}`;
    const original = ["- Never delete", detail(0), detail(1), "- Mom's birthday is March 3", ...Array.from({ length: 56 }, (_, i) => detail(i + 2))].join("\n") + "\n";
    const typed = async () => (await load()).typedHashes(bot.id, dataDir);

    beforeEach(async () => {
      const { createMemoryClean } = await load();
      clock = Date.UTC(2026, 10, 4);
      dataDir = temps.make(join(scratch, "sleep-"));
      store = new Store(() => ({ instanceId: "codex", model: "gpt-6.1" }));
      for (const old of store.bots) store.deleteBot(old.id);
      bot = store.createBot();
      bot.memoryNotes = false;
      writeMemoryFile(bot.id, original);
      store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "Jun moved to Jeju in May" });
      store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "Remember Mom's birthday is March 3" });
      changes = [
        learn("Jun moved to Jeju", "- Jun moved to Jeju in May"), { op: "own", id: 4, quote: "Mom's birthday is March 3", reason: "Asked to remember" },
        { op: "file", ids: [2, 3], topic: "details", pointer: "- memory/details.md: the first two details", reason: "Detail" },
      ];
      const engine = { propose: proposer(() => changes), recall: answerer(), key: "own" };
      const home: HomeInput = { device: "000000000001" };
      service = createMemoryClean({ store, dataDir, engine: async () => engine, busy: () => false, pending: () => false, home: () => home, now: () => clock });
    });

    afterEach(() => { service.dispose(); sabotage.undo = false; });

    it("undoes learned owned and filed changes byte for byte and owns restored lines", async () => {
      const { lineHash } = await load();
      clock += 600_000; await service.run(bot.id);
      const memory = memoryFileRaw(bot.id);
      expect(memory).toContain("\n- Jun moved to Jeju in May\n");
      expect(memory).toContain("- memory/details.md: the first two details\n");
      expect(readFileSync(join(workspaceDir(bot.id), "memory/details.md"), "utf8")).toBe(`${detail(0)}\n${detail(1)}\n`);
      expect(await typed()).toContain(lineHash("- Mom's birthday is March 3"));
      const runId = service.summary(bot.id).run!.runId;
      expect(readFileSync(join(dataDir, "sleep", bot.id, runId, "MEMORY.md"), "utf8")).toBe(original);
      expect(await service.undo(bot.id, runId)).toMatchObject({ ok: true });
      expect(memoryFileRaw(bot.id)).toBe(original);
      expect(existsSync(join(workspaceDir(bot.id), "memory/details.md"))).toBe(false);
      expect(await typed()).not.toContain(lineHash("- Mom's birthday is March 3"));
      expect(await typed()).toEqual(expect.arrayContaining([lineHash(detail(0)), lineHash(detail(1))]));
    });

    it("aborts the write when undo cannot rebuild the old file", async () => {
      const { cleanFiles } = await load();
      sabotage.undo = true;
      expect(await cleanFiles(night("- kept\n- old done\n", [retire(2)]))).toMatchObject({ ok: false, stage: "validate", detail: "undo-proof" });
      clock += 600_000; await service.run(bot.id);
      expect(memoryFileRaw(bot.id)).toBe(original);
      expect(existsSync(join(workspaceDir(bot.id), "memory/memory-history.md"))).toBe(false);
      expect(existsSync(join(dataDir, "sleep"))).toBe(false);
    });
  });
});

describe("history and parked copies", () => {
  it("records typed additions only, strips unknown state keys and never throws", async () => {
    const { lineHash, recordTypedLines, typedHashes } = await load();
    const dir = temps.make(join(scratch, "state-"));
    recordTypedLines("b", "- old\r\n", "- old\n- typed\n", dir);
    recordTypedLines("b", "", "- typed\n", dir);
    expect(typedHashes("b", dir)).toEqual([lineHash("- typed")]);
    writeFileSync(join(dir, "memory-clean.json"), JSON.stringify({ version: 1, unknown: 1, bots: { b: { typed: [lineHash("- typed")], unknown: 1 } } }));
    recordTypedLines("b", "", "- added", dir);
    expect(JSON.parse(readFileSync(join(dir, "memory-clean.json"), "utf8"))).toEqual({ version: 1, bots: { b: { typed: [lineHash("- typed"), lineHash("- added")] } } });
    expect(lineHash("  - typed\r")).toBe(lineHash("- typed"));
    expect(typedHashes("b", dir)).toEqual([lineHash("- typed"), lineHash("- added")]);
    writeFileSync(join(dir, "memory-clean.json"), "bad");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => recordTypedLines("b", "", "- safe", dir)).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("caps typed hashes at the newest 2000 in their original order", async () => {
    const { recordTypedLines, typedHashes, lineHash } = await load();
    const dir = temps.make(join(scratch, "typed-cap-"));
    recordTypedLines("b", "", Array.from({ length: 2001 }, (_, i) => `- typed ${i}`).join("\n"), dir);
    expect(typedHashes("b", dir)).toEqual(Array.from({ length: 2000 }, (_, i) => lineHash(`- typed ${i + 1}`)));
  });

  it("retains CRLF bytes and ignores malformed blocks", async () => {
    const { parseHistory } = await load();
    const header = { v: 1, runId: "mc-20261104-12345678", at: 1, files: {}, merged: 0, replaced: 0, moved: 1 };
    const entry = { file: "MEMORY.md", op: "retire", at: [2], prev: [""], wrote: [] };
    const block = `<!-- mc-run ${JSON.stringify(header)} -->\n## cleanup\n\n<!-- mc-entry ${JSON.stringify(entry)} -->\nDone\n- old\r\n\n`;
    expect(parseHistory(`<!-- mc-run bad -->\n${block}`)[0]?.entries[0]?.lines).toEqual(["- old\r"]);
  });

  it("only merges a parked copy when history retired one of its missing lines", async () => {
    const { mergeParkedCopy } = await load();
    expect(mergeParkedCopy({ file: "MEMORY.md", kept: "- kept\n", parked: "- new\n", history: null })).toBeNull();
    const history = historyBlock();
    expect(mergeParkedCopy({ file: "MEMORY.md", kept: "- kept\n", parked: "- old\n- new\n- another\n", history })).toBe("- kept\n- new\n- another\n");
    expect(mergeParkedCopy({ file: "MEMORY.md", kept: "- kept\n", parked: "- new\n", history })).toBeNull();
  });

  it("merges whole history blocks by run id without duplicates", async () => {
    const { mergeParkedCopy, parseHistory } = await load();
    const one = historyBlock();
    const two = historyBlock("mc-20261104-abcdefab");
    const merged = mergeParkedCopy({ file: "memory/memory-history.md", kept: one, parked: one + two, history: one });
    expect(parseHistory(merged ?? "").map((run) => run.header.runId)).toEqual(["mc-20261104-12345678", "mc-20261104-abcdefab"]);
  });

  it("picks the newest home, breaks ties by device, and fails closed on unreadable folders", async () => {
    const { memoryCleanHome } = await import("./memory-clean-home.ts");
    expect(memoryCleanHome({ device: "000000000001", botSyncId: "b" })).toMatchObject({ home: true });
    const folder = temps.make(join(scratch, "sync-"));
    const root = join(folder, "memory-v2", "b");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "000000000002.json"), JSON.stringify({ device: "000000000002", talkedAt: 10, typed: ["1234567890abcdef"] }));
    const input = { folder, botSyncId: "b", device: "000000000001", talkedAt: 9 };
    expect(memoryCleanHome(input)).toMatchObject({ home: false });
    expect(memoryCleanHome({ ...input, talkedAt: 10 })).toMatchObject({ home: true });
    expect(memoryCleanHome({ ...input, talkedAt: 11 }).typed.has("1234567890abcdef")).toBe(true);
    writeFileSync(join(root, "000000000003.json"), "bad");
    expect(memoryCleanHome(input)).toMatchObject({ home: false });
    expect(memoryCleanHome({ ...input, folder: join(folder, "missing") })).toMatchObject({ home: false });
  });
});

function historyBlock(runId = "mc-20261104-12345678") {
  return `<!-- mc-run ${JSON.stringify({ v: 1, runId, at: 1, files: {}, merged: 0, replaced: 0, moved: 1 })} -->\n\n<!-- mc-entry ${JSON.stringify({ file: "MEMORY.md", op: "retire", at: [1], prev: [""], wrote: [] })} -->\nDone\n- old\n\n`;
}
