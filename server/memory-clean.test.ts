import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CleanInput, TextCall } from "./memory-clean.ts";
import type { HomeInput } from "./memory-clean-home.ts";
import { day } from "./memory-pass.ts";
import { Store } from "./store.ts";
import { createTempDirs } from "./testing/cleanup.ts";
import { sleepReply } from "./testing/sleep-verdicts.ts";
import { withSystemChanges } from "./turn-context.ts";
import { memoryFileRaw, workspaceDir, writeMemoryFile } from "./workspace.ts";

const sabotage = vi.hoisted(() => ({ undo: false }));
const race = vi.hoisted(() => ({ after: null as null | ((path: string) => void) }));
vi.mock("./atomic.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./atomic.ts")>();
  return { ...real, writeFileAtomic: (...args: Parameters<typeof real.writeFileAtomic>) => {
    real.writeFileAtomic(...args);
    race.after?.(String(args[0]));
  } };
});
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
    ["budget", `- a b\n- c d\n${"x".repeat(23990)}`, list([{ op: "merge", ids: [1, 2], text: `- a b c d ${"e".repeat(250)}`, reason: "Same subject" }]), "MEMORY.md"],
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
    expect(await validate("- port 9\n- Always use port 11", [{ op: "replace", id: 1, newer: 2, reason: "Current" }])).toMatchObject({ ok: true });
    expect(await validate("- port 11 (noted 2026-11-04)\n- port 9 (noted 2026-10-01)", [{ op: "replace", id: 2, newer: 1, reason: "Current" }])).toMatchObject({ ok: true });
  });

  it.each(["pending", "PARKED", "await", "awaits", "awaiting", "대기", "보류"])("protects %s from retire but allows replacement", async (marker) => {
    const text = `- task T-1128 ${marker}\n- task T-1128 completed`;
    expect(await validate(text, [retire(1)])).toMatchObject({ ok: false, errors: [{ reason: "protected", change: 0 }] });
    expect(await validate(text, [{ op: "replace", id: 1, newer: 2, reason: "Current" }])).toMatchObject({ ok: true, text: "- task T-1128 completed" });
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
let filed: string[] = [];
const proposer = (changes: () => unknown[]) => vi.fn<TextCall>(async (prompt) => {
  const staged = sleepReply(prompt);
  if (staged !== null) return staged;
  if (prompt.startsWith("[memory-clean:questions]")) {
    filed = JSON.parse(/Ask at least one such question for each of: (\[[^\]]*\])/.exec(prompt)?.[1] ?? "[]");
    return JSON.stringify(quiz.map((q, i) => filed[i] ? { ...q, file: filed[i], answer: filed[i] } : q));
  }
  if (prompt.startsWith("[memory-clean:grade]")) return JSON.stringify(JSON.parse(prompt.slice(prompt.indexOf("\n\n") + 2)).map(() => true));
  return JSON.stringify(list(changes()));
});
const answerer = () => vi.fn<TextCall>(async (prompt) => {
  const staged = sleepReply(prompt);
  if (staged !== null) return staged;
  return JSON.stringify(quiz.map((q, i) => filed[i] ?? q.answer));
});
const night = (memory: string, changes: unknown[], extra: Partial<CleanInput> = {}): CleanInput =>
  ({ memory, history: null, typed: new Set(), now: Date.UTC(2026, 10, 7), propose: proposer(() => changes), recall: answerer(), ...extra });
const learn = (quote: string, text: string, lesson = false) => ({ op: "learn", text, quote, lesson, reason: "User said it" });
const said = (text: string, kind: "said" | "remember" | "correction" = "said", at = 150) => ({ text, at, kind });
const local = (ms: number) => { const date = new Date(ms); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };
const rejects = (reason: string) => ({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ reason })]) });

describe("sleep", () => {
  it("learns a fact only when it quotes a user line from this night", async () => {
    const { cleanFiles, validateChangeList } = await load();
    const user = [said("Jun moved to Jeju in May")];
    const result = await cleanFiles(night("- kept\n", [learn("Jun moved to Jeju", "- Jun moved to Jeju in May")], { user, through: 150 }));
    expect(result).toMatchObject({ ok: true, header: { v: 2, through: 150, counts: { learned: 1 } } });
    expect(result.ok && result.memory.split("\n").slice(0, 2)).toEqual(["- kept", `- Jun moved to Jeju in May (noted ${day(150)})`]);
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

  describe("fix-up from the DREAM-AUDIT", () => {
    const check = async (text: string, changes: unknown[], user: Array<ReturnType<typeof said>> = []) =>
      (await load()).validateChangeList({ file: "MEMORY.md", text, typed: new Set(), user, list: list(changes) });
    const replace = (id: number, newer: number) => ({ op: "replace", id, newer, reason: "Current" });
    const filler = (count: number, width: number) => Array.from({ length: count }, (_, i) => `- note ${i} ${"z".repeat(width)}`).join("\n") + "\n";

    it("replaces a line only with a newer line about the same subject", async () => {
      expect(await check("- dentist visit on Monday\n- gym opens at 6am\n", [replace(1, 2)])).toMatchObject(rejects("not-newer"));
      expect(await check("- task pending signature\n- task completed\n", [replace(1, 2)])).toMatchObject(rejects("not-newer"));
      expect(await check("- headcount 8\n- headcount 9\n", [replace(1, 2)])).toMatchObject({ ok: true });
      expect(await check("- PR 1128 pending review\n- PR 1128 merged\n", [replace(1, 2)])).toMatchObject({ ok: true });
      expect(await check("- 회의는 3시\n- 회의는 4시\n", [replace(1, 2)])).toMatchObject({ ok: true });
    });

    it("learns only a line that keeps its quote's words and negation", async () => {
      expect(await check("- kept\n", [learn("I do not drink coffee", "- Drinks coffee")], [said("I do not drink coffee")])).toMatchObject(rejects("not-quoted"));
      expect(await check("- kept\n", [learn("커피를 좋아해", "- 녹차를 싫어함")], [said("나는 커피를 좋아해")])).toMatchObject(rejects("not-quoted"));
      expect(await check("- kept\n", [learn("I do not drink coffee", "- Does not drink coffee")], [said("I do not drink coffee")])).toMatchObject({ ok: true });
      expect(await check("- kept\n", [learn("커피를 안 마셔", "- 커피를 안 마심")], [said("요즘 커피를 안 마셔")])).toMatchObject({ ok: true });
    });

    it("drops each change the answerer cannot confirm and lands the rest", async () => {
      const { cleanFiles } = await load();
      for (const verdicts of [[true, true], [false, true], [true, false]] as const) {
        const recall = vi.fn<TextCall>(async (prompt) => prompt.startsWith("[memory-clean:organize]") ? JSON.stringify({ verdicts, corrections: [] }) : JSON.stringify(quiz.map((q) => q.answer)));
        const result = await cleanFiles(night("- kept\n- old plan done\n", [retire(2), learn("Jun moved to Jeju", "- Jun moved to Jeju in May")], { user: [said("Jun moved to Jeju in May")], recall }));
        expect(result).toMatchObject({ ok: true });
        expect(result.ok && [result.memory.includes("- old plan done"), result.memory.includes("- Jun moved to Jeju in May")]).toEqual([!verdicts[0], verdicts[1]]);
        expect(recall.mock.calls[0]![0]).toContain('"sources":["- old plan done"]');
        expect(recall.mock.calls[0]![0]).toContain('"quote":"Jun moved to Jeju in May"');
      }
    });

    it("keeps lowercase and Korean content words in a merge", async () => {
      const merge = (text: string) => [{ op: "merge", ids: [1, 2], text, reason: "Same subject" }];
      expect(await check("- staging deploys on friday\n- prod deploys on monday\n", merge("- deploys on monday"))).toMatchObject(rejects("fact-lost"));
      expect(await check("- 스테이징 배포는 금요일 오후\n- 운영 배포는 월요일\n", merge("- 배포는 월요일"))).toMatchObject(rejects("fact-lost"));
      expect(await check("- staging deploys on friday\n- prod deploys on monday\n", merge("- staging deploys friday, prod deploys monday"))).toMatchObject({ ok: true });
    });

    it("dates a learned line with the day its user line was said", async () => {
      const { cleanFiles } = await load();
      const at = Date.UTC(2026, 10, 3, 12);
      const result = await cleanFiles(night("- kept\n", [learn("Jun moved to Jeju", "- Jun moved to Jeju in May")], { user: [said("Jun moved to Jeju in May", "said", at)] }));
      expect(result.ok && result.memory).toContain(`\n- Jun moved to Jeju in May (noted ${local(at)})\n`);
    });

    it("files lines only behind a pointer that names their key facts", async () => {
      const text = Array.from({ length: 60 }, (_, i) => `- trip ${i} stop at Harbor${i} ${"x".repeat(280)}`).join("\n") + "\n";
      const file = (pointer: string) => [{ op: "file", ids: [1, 2], topic: "trips", pointer, reason: "Detail" }];
      expect(await check(text, file("- memory/trips.md: early trips"))).toMatchObject(rejects("pointer"));
      expect(await check(text, file("- memory/trips.md: trips 0 and 1 via Harbor0, Harbor1"))).toMatchObject({ ok: true });
      const mixed = ["- Storage unit at Paju: number 1252", "- Bike repair ticket: VG-8935", "- Locker at the Gimpo gym: 9285", "- Tailor Lorpellick: 5555 won per hem", (await load()).POINTER_LINE, filler(60, 280)].join("\n");
      const four = (pointer: string) => [{ op: "file", ids: [1, 2, 3, 4], topic: "personal-facts", pointer, reason: "Detail" }];
      expect(await check(mixed, four("- Personal facts: storage unit 1252, bike ticket VG-8935, Gimpo locker 9285 are in memory/personal-facts.md"))).toMatchObject(rejects("pointer"));
      expect(await check(mixed, four("- Storage unit 1252, bike ticket VG-8935, Gimpo locker 9285, tailor Lorpellick: memory/personal-facts.md"))).toMatchObject({ ok: true });
    });

    it("opens a new Lessons section after the title and closes it so later appends stay out", async () => {
      const user = [said("No, the dentist is on Tuesday", "correction")];
      const lesson = [learn("the dentist is on Tuesday", "- Dentist is on Tuesday", true)];
      const shape = async (text: string) => {
        const result = await check(text, lesson, user);
        return result.ok && result.text.split("\n").map((line) => line.replace(/ \(noted [^)]*\)$/, ""));
      };
      expect(await shape("# Memory\n- a\n- b\n")).toEqual(["# Memory", "## Lessons", "- Dentist is on Tuesday", "## Notes", "- a", "- b", ""]);
      expect(await shape("- a\n## Work\n- b\n")).toEqual(["## Lessons", "- Dentist is on Tuesday", "## Notes", "- a", "## Work", "- b", ""]);
      expect(await shape("## Pinned\n- a\n")).toEqual(["## Lessons", "- Dentist is on Tuesday", "## Pinned", "- a", ""]);
    });

    it("treats a question or I don't remember as a plain line, not a remember request", async () => {
      const { sleepInput } = await load();
      const rows = ["Do you remember my sister's name?", "I don't remember the gate code", "그거 기억해?", "Remember the gate code is 4417"].map((text, i) => ({ id: `${i}`, role: "user", kind: "text", text, at: 10 + i }));
      expect(Object.fromEntries(sleepInput(rows as never, 0, 100).user.map((line) => [line.text, line.kind]))).toEqual({
        "Do you remember my sister's name?": "said", "I don't remember the gate code": "said", "그거 기억해?": "said", "Remember the gate code is 4417": "remember",
      });
    });

    it("counts a remember line kept only when one line holds all its facts", async () => {
      const result = await check("- Mina likes tea\n- locker 4417 is broken\n", [], [said("Remember Mina's locker is 4417", "remember")]);
      expect(result.ok && result.text).toContain("\n- Remember Mina's locker is 4417\n");
    });

    it("reserves forced remembers under the no-growth rule", async () => {
      const text = `${filler(70, 280)}- old plan done\n`;
      expect(Buffer.byteLength(text)).toBeGreaterThan(16 * 1024);
      expect(await check(text, [retire(71)], [said("Remember the gate code is 4417", "remember")])).toMatchObject(rejects("budget"));
      expect(await check(text, [retire(1)], [said("Remember the gate code is 4417", "remember")])).toMatchObject({ ok: true });
    });

    it("accepts a night that shrinks a file already over 24 KB, never one that grows it", async () => {
      const text = `${filler(84, 280)}- old plan done\n`;
      expect(Buffer.byteLength(text)).toBeGreaterThan(24_000);
      expect(await check(text, [retire(85)])).toMatchObject(rejects("budget"));
      expect(await check(text, [retire(1)])).toMatchObject({ ok: true });
      expect(await check(text, [learn("Jun moved to Jeju", "- Jun moved to Jeju in May")], [said("Jun moved to Jeju in May")])).toMatchObject(rejects("budget"));
      expect(await check(text, [retire(1)], [said("Remember the gate code is 4417", "remember")])).toMatchObject({ ok: true });
    });

    it("asks a file over 24 KB only to end smaller tonight", async () => {
      const { cleanFiles } = await load();
      for (const memory of ["- kept\n", `${filler(84, 280)}- old plan done\n`]) {
        const input = night(memory, []);
        await cleanFiles(input);
        expect(vi.mocked(input.propose).mock.calls[0]![0]).toContain("above 24000, end strictly smaller");
      }
    });

    it("does not restore a line that is already back", async () => {
      const { cleanFiles, parseHistory } = await load();
      const { undoText } = await import("./memory-clean-undo.ts");
      const result = await cleanFiles(night("- before\n- old plan done\n- after\n", [retire(2)]));
      if (!result.ok) throw new Error(result.detail);
      const undone = undoText("MEMORY.md", `${result.memory}- old plan done\n`, parseHistory(result.block)[0]!);
      expect(undone.text.split("\n").filter((line) => line === "- old plan done")).toHaveLength(1);
    });

    it("reports a budget stop as a failed night, not a quiet one", async () => {
      const { cleanFiles } = await load();
      expect(await cleanFiles(night("x".repeat(240_000), [retire(1)]))).toMatchObject({ ok: false, stage: "propose", detail: "budget" });
    });

    it("merges a rule or pointer line only when every rule word, fact and path stays", async () => {
      const { cleanFiles, lineHash, parseHistory, validateChangeList } = await load();
      const { undoText } = await import("./memory-clean-undo.ts");
      const merge = (text: string) => [{ op: "merge", ids: [1, 2], text, reason: "Same subject" }];
      const rules = "- Never deploy on Fridays\n- Never deploy on Fridays after 5pm\n";
      expect(await check(rules, merge("- Never deploy on Fridays, even after 5pm"))).toMatchObject({ ok: true });
      expect(await check(rules, merge("- Deploy on Fridays before 5pm"))).toMatchObject(rejects("protected"));
      expect(validateChangeList({ file: "MEMORY.md", text: rules, typed: new Set([lineHash("- Never deploy on Fridays")]), list: list(merge("- Never deploy on Fridays, even after 5pm")) })).toMatchObject(rejects("protected"));
      expect(await check(`## Lessons\n${rules}`, [{ op: "merge", ids: [2, 3], text: "- Never deploy on Fridays, even after 5pm", reason: "Same" }])).toMatchObject(rejects("protected"));
      expect(await check("- Correction: the build must use node 22\n- build must use node 22\n", merge("- build must use node 22"))).toMatchObject(rejects("protected"));
      const pointers = "- trips are in memory/trips.md\n- stops are in memory/stops.md\n";
      expect(await check(pointers, merge("- trips and stops are in memory/trips.md and memory/stops.md"))).toMatchObject({ ok: true });
      expect(await check(pointers, merge("- trips and stops are in memory/trips.md"))).toMatchObject(rejects("pointer"));
      const result = await cleanFiles(night(`- kept\n${rules}`, [{ op: "merge", ids: [2, 3], text: "- Never deploy on Fridays, even after 5pm", reason: "Same" }]));
      if (!result.ok) throw new Error(result.detail);
      expect(undoText("MEMORY.md", result.memory, parseHistory(result.block)[0]!).text).toBe(`- kept\n${rules}`);
    });

    it("files a pointer line only behind a pointer that names every path it held", async () => {
      const text = ["- see memory/alpha.md for Harbor0 trips", "- see memory/beta.md for Harbor1 trips", "- always read memory/gamma.md for Harbor2 first",
        (await load()).POINTER_LINE, ...Array.from({ length: 60 }, (_, i) => `- trip ${i} ${"x".repeat(280)}`)].join("\n") + "\n";
      const file = (ids: number[], pointer: string) => [{ op: "file", ids, topic: "pointers", pointer, reason: "Index" }];
      expect(await check(text, file([1, 2], "- memory/pointers.md: memory/alpha.md (Harbor0), memory/beta.md (Harbor1)"))).toMatchObject({ ok: true });
      expect(await check(text, file([1, 2], "- memory/pointers.md: memory/alpha.md, Harbor0, Harbor1"))).toMatchObject(rejects("pointer"));
      expect(await check(text, file([3], "- memory/pointers.md: always read memory/gamma.md for Harbor2 first"))).toMatchObject(rejects("protected"));
    });

    it("caps net growth at 1 KB a night including remember appends", async () => {
      const lines = Array.from({ length: 4 }, (_, i) => `Jun route ${i} ${"walks along the river ".repeat(12).trim()}`);
      const user = lines.map((line) => said(line));
      expect(await check("- kept\n", lines.map((line) => learn(line, `- ${line}`)), user)).toMatchObject(rejects("cap-growth"));
      expect(await check("- kept\n", lines.slice(0, 3).map((line) => learn(line, `- ${line}`)), user)).toMatchObject({ ok: true });
      expect(await check("- kept\n", lines.slice(0, 3).map((line) => learn(line, `- ${line}`)), [...user, said(`Remember the gate code is 4417 ${"by the north door ".repeat(8)}`, "remember")])).toMatchObject(rejects("cap-growth"));
    });

    it("merges dated twins under their newest stamp and still fails a dropped date", async () => {
      const text = "- Dentist: Dr. Kasquilick, 2026-12-12 at 10:40 (noted 2026-11-07)\n- Dentist - Dr. Kasquilick, 2026-12-12 at 10:40 (noted 2026-11-05)\n";
      const merge = (text: string) => [{ op: "merge", ids: [1, 2], text, reason: "Same booking" }];
      for (const value of ["- Dentist: Dr. Kasquilick, 2026-12-12 at 10:40", "- Dentist: Dr. Kasquilick, 2026-12-12 at 10:40 (noted 2026-11-05)"]) {
        const result = await check(text, merge(value));
        expect(result.ok && result.text).toBe("- Dentist: Dr. Kasquilick, 2026-12-12 at 10:40 (noted 2026-11-07)\n");
      }
      expect(await check(text, merge("- Dentist: Dr. Kasquilick at 10:40"))).toMatchObject(rejects("fact-lost"));
    });

    it("learns a line that repeats its stamp or quotes a don't forget", async () => {
      const user = [said("make a note that Kaswexick prefers calls after 4pm", "remember"), said("don't forget: the Toryorick badge pickup is booth 4497", "remember")];
      const result = await check("- kept\n", [learn("make a note that Kaswexick prefers calls after 4pm", "- Kaswexick prefers calls after 4pm (noted 2026-11-07)"),
        learn("don't forget: the Toryorick badge pickup is booth 4497", "- Toryorick badge pickup is booth 4497")], user);
      expect(result.ok && result.text.split("\n").slice(1, 3)).toEqual([`- Kaswexick prefers calls after 4pm (noted ${day(150)})`, `- Toryorick badge pickup is booth 4497 (noted ${day(150)})`]);
      expect(await check("- kept\n", [learn("don't forget I do not drink coffee", "- Drinks coffee")], [said("don't forget I do not drink coffee", "remember")])).toMatchObject(rejects("not-quoted"));
    });

    it("never force-appends a line that only mentions remembering", async () => {
      const { cleanFiles, sleepInput } = await load();
      const plain = ["OH i remember, the group thing!", "lately i can't focus and remember. so keep it short", "it opens index n stuff, just from what i remember",
        "feels like you dont remember what you did", "Wonder if u will remember it all", "yeah thats easy for me to remember"];
      const asks = ["and also remember to keep an eye out on bug reports", "fyi remember the credits land at 9am", "Thanks. Remember there are multiple terminal themes.",
        "make a note that Kaswexick prefers calls after 4pm", "don't forget: the badge pickup is booth 4497", "기억해: 렌터카 예약 번호는 8068"];
      const rows = [...plain, ...asks].map((text, i) => ({ id: `${i}`, role: "user", kind: "text", text, at: 10 + i }));
      const { user } = sleepInput(rows as never, 0, 100);
      expect(user.filter((line) => line.kind === "remember").map((line) => line.text).sort()).toEqual([...asks].sort());
      const result = await cleanFiles(night("- kept\n", [], { user }));
      expect(result.ok && plain.filter((line) => result.memory.includes(line))).toEqual([]);
    });

    it("tells the proposer what remember appends will cost and how many bytes a full file is over", async () => {
      const { cleanFiles, POINTER_LINE } = await load();
      const user = [said("Remember the gate code is 4417", "remember")];
      const full = `${filler(84, 280)}- old plan done\n`;
      for (const memory of ["- kept\n", full]) {
        const input = night(memory, [], { user });
        await cleanFiles(input);
        const ask = vi.mocked(input.propose).mock.calls[0]![0];
        const reserved = JSON.parse(/Reserved complete candidate: ({.*})\. Protected floor:/.exec(ask)![1]!);
        expect(reserved.forcedBytes).toBe(33);
        expect(reserved.finalBytes).toBe(Buffer.byteLength(memory) + 33 + Buffer.byteLength(POINTER_LINE) + 1);
        expect(ask).toContain("At most two packets of 12 source IDs");
      }
      expect(await check(full, [], user)).toMatchObject({ ok: false, errors: [{ reason: "budget", over: 34 + Buffer.byteLength(POINTER_LINE) + 1 }] });
      const side = night("- kept\n", [], { user, side: { file: "memory/topic.md", text: "- topic\n" } });
      await cleanFiles(side);
      expect(vi.mocked(side.propose).mock.calls.find(([prompt]) => prompt.includes('"file":"memory/topic.md"'))![0]).toContain("At most two packets of 12 source IDs");
    });

    it("reads apostrophes in contractions as words, not quotes", async () => {
      const user = [said("no there was something else. it wasn't vibe coded, cause we know vibe means developing without a plan")];
      expect(await check("- kept\n", [learn("it wasn't vibe coded, cause we know vibe means developing without a plan", "Eddie's work isn't vibe coded: vibe means developing without a plan.", true)], user)).toMatchObject({ ok: true });
      expect((await load()).factTokens("- Eddie's note says 'ship it' today")).toContain("'ship it'");
    });

    it("leaves remember appends out of the line cap only", async () => {
      const { cleanFiles } = await load();
      const user = [said("Remember the gate code is 4417", "remember")];
      const memory = `${filler(41, 10)}${(await load()).POINTER_LINE}\n`;
      const retires = (n: number) => Array.from({ length: n }, (_, i) => retire(i + 1));
      expect(await check(memory, retires(40), user)).toMatchObject({ ok: true });
      expect(await check(memory, retires(41), user)).toMatchObject(rejects("cap-lines"));
      const result = await cleanFiles(night(memory, retires(12), { user }));
      expect(result).toMatchObject({ ok: true });
      expect(result.ok && result.memory).toContain("- Remember the gate code is 4417");
      expect(await cleanFiles(night(memory, retires(40), { user }))).toMatchObject({ ok: false, stage: "validate", detail: "packet" });
    });

    it("leaves the side file for a later night while MEMORY.md is heavy", async () => {
      const { cleanFiles } = await load();
      const input = night(filler(60, 280), Array.from({ length: 12 }, (_, i) => retire(i + 1)), { side: { file: "memory/topic.md", text: "- topic\n" } });
      const result = await cleanFiles(input);
      expect(result).toMatchObject({ ok: true });
      expect(result.ok && result.side).toBeUndefined();
      expect(vi.mocked(input.propose).mock.calls.some(([prompt]) => prompt.includes('"file":"memory/topic.md"'))).toBe(false);
    });

    it("sends each recall line once", async () => {
      const { cleanFiles } = await load();
      const memory = "- kept\n- Dentist: Dr. Kasquilick, 2026-12-12 at 10:40\n- Dentist - Dr. Kasquilick, 2026-12-12\n- Never deploy on Fridays\n- old plan done\n";
      const input = night(memory, [{ op: "merge", ids: [2, 3], text: "- Dentist: Dr. Kasquilick, 2026-12-12 at 10:40", reason: "Same" }, retire(5)]);
      expect(await cleanFiles(input)).toMatchObject({ ok: true });
      const asked = vi.mocked(input.propose).mock.calls.map(([prompt]) => prompt).find((prompt) => prompt.startsWith("[memory-clean:questions]"))!;
      const answered = vi.mocked(input.recall).mock.calls.find(([prompt]) => prompt.startsWith("[memory-clean:answers]"))![0];
      for (const line of ["- Dentist - Dr. Kasquilick, 2026-12-12", "- Never deploy on Fridays", "- old plan done"]) expect(asked.split(line)).toHaveLength(2);
      expect(answered).not.toContain("<!-- mc-");
      expect(answered).toContain("History (removed lines):\n- old plan done");
    });
  });

  describe("service", () => {
    let clock: number;
    let dataDir: string;
    let store: Store;
    let bot: ReturnType<Store["createBot"]>;
    let changes: unknown[];
    let service: ReturnType<Awaited<ReturnType<typeof load>>["createMemoryClean"]>;
    const detail = (i: number) => `- detail ${i} ${"x".repeat(280)}`;
    // the floor files the larger fillers, so the model's file op on 2 and 3 rides on top
    const original = ["- Never delete", detail(0), detail(1), "- Mom's birthday is March 3", ...Array.from({ length: 3 }, (_, i) => `- filler ${i} ${"z".repeat(285)}`),
      ...Array.from({ length: 53 }, (_, i) => detail(i + 2))].join("\n") + "\n";
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
        { op: "file", ids: [2, 3], topic: "details", pointer: "- memory/details.md: details 0 and 1", reason: "Detail" },
      ];
      const engine = { propose: proposer(() => changes), recall: answerer(), key: "own" };
      const home: HomeInput = { device: "000000000001" };
      service = createMemoryClean({ store, dataDir, engine: async () => engine, busy: () => false, pending: () => false, home: () => home, now: () => clock });
    });

    afterEach(() => { service.dispose(); sabotage.undo = false; race.after = null; });

    it.each(["restore", "void"])("takes back a night whose memory write loses a race after the archive: %s", async (mode) => {
      const { parseHistory } = await load();
      const path = join(workspaceDir(bot.id), "memory/memory-history.md");
      race.after = (file) => {
        if (!file.endsWith("memory-history.md")) return;
        race.after = null;
        writeMemoryFile(bot.id, `${original}- concurrent\n`);
        if (mode === "void") writeFileSync(path, `${readFileSync(path, "utf8")}- synced in\n`);
      };
      clock += 600_000; await service.run(bot.id);
      expect(memoryFileRaw(bot.id)).toBe(`${original}- concurrent\n`);
      expect(service.summary(bot.id)).toEqual({ run: null });
      expect(existsSync(path)).toBe(mode === "void");
      if (mode === "void") expect(parseHistory(readFileSync(path, "utf8"))).toEqual([]);
      expect(existsSync(join(workspaceDir(bot.id), "memory/details.md"))).toBe(false);
    });

    it("undoes learned owned and filed changes byte for byte and owns restored lines", async () => {
      const { lineHash } = await load();
      clock += 600_000; await service.run(bot.id);
      const memory = memoryFileRaw(bot.id);
      expect(memory).toMatch(/\n- Jun moved to Jeju in May \(noted \d{4}-\d{2}-\d{2}\)\n/);
      expect(memory).toContain("- memory/details.md: detail 0; detail 1\n");
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

  it("drops typed hashes of lines no memory file holds before the 2,000 cap", async () => {
    const { lineHash, recordTypedLines, typedHashes } = await load();
    const dir = temps.make(join(scratch, "typed-prune-"));
    writeMemoryFile("sleep-prune", "- typed and still here\n");
    const stale = Array.from({ length: 1999 }, (_, i) => lineHash(`- deleted ${i}`));
    writeFileSync(join(dir, "memory-clean.json"), JSON.stringify({ version: 1, bots: { "sleep-prune": { typed: [lineHash("- typed and still here"), ...stale] } } }));
    recordTypedLines("sleep-prune", "", "- newly typed", dir);
    expect(typedHashes("sleep-prune", dir)).toEqual([lineHash("- typed and still here"), lineHash("- newly typed")]);
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
