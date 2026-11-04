import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it, vi } from "vitest";

import { createTempDirs } from "./testing/cleanup.ts";
import { withSystemChanges } from "./turn-context.ts";

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
