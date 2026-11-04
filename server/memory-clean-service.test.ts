import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMemoryClean, cleanFiles, parseHistory, POINTER_LINE, type Change, type TextCall } from "./memory-clean.ts";
import type { HomeInput } from "./memory-clean-home.ts";
import { Store } from "./store.ts";
import { createTempDirs } from "./testing/cleanup.ts";
import { memoryFileRaw, workspaceDir, writeMemoryFile } from "./workspace.ts";

const temps = createTempDirs();
const scratch = join(tmpdir(), "wink-CLEAN-CORE");
mkdirSync(scratch, { recursive: true });
afterAll(() => temps.remove());
const DAY = 86_400_000;
const QUIET = 600_000;
const NOW = Date.UTC(2026, 10, 4);
const retire = (id: number): Change => ({ op: "retire", id, reason: "Completed" });
const questions = () => Array.from({ length: 18 }, (_, i) => ({ kind: i < 12 ? "changed" : i < 16 ? "protected" : "absent", question: `Fact ${i}?`, answer: i < 16 ? `value ${i}` : null }));

function calls(changes: Change[] = [retire(2)]) {
  const propose = vi.fn<TextCall>(async (prompt) => {
    if (prompt.startsWith("[memory-clean:questions]")) return JSON.stringify(questions());
    if (prompt.startsWith("[memory-clean:grade]")) return JSON.stringify(Array(18).fill(true));
    const file = /"file":"([^"]+)"/.exec(prompt)?.[1] ?? "MEMORY.md";
    return JSON.stringify({ version: 1, file, changes });
  });
  const recall = vi.fn<TextCall>(async () => JSON.stringify(questions().map((q) => q.answer)));
  return { propose, recall };
}

describe("cleanFiles recall", () => {
  it.each(["fenced", "plain-fence", "numeric", "boolean", "prose"])("parses %s answers and rejects invalid arrays", async (kind) => {
    const engine = calls();
    const input = { memory: "- kept\n- old\n", history: null, typed: new Set<string>(), ...engine };
    for (const answer of ["[]", JSON.stringify(Array(19).fill(null)), '{"answers":[]}', JSON.stringify(Array(18).fill({ value: 1 })), `\`\`\`json\n${JSON.stringify({ answers: Array(18).fill(null) })}\n\`\`\``]) {
      engine.recall.mockResolvedValue(answer);
      expect(await cleanFiles(input)).toMatchObject({ ok: false, stage: "recall" });
    }
    const answers: Array<string | number | boolean | null> = questions().map((q) => q.answer);
    if (kind === "numeric") answers[0] = 792;
    if (kind === "boolean") answers[0] = false;
    const json = JSON.stringify(answers);
    engine.recall.mockResolvedValue(kind === "fenced" ? `\`\`\`json\n${json}\n\`\`\`` : kind === "plain-fence" ? `\`\`\`\n${json}\n\`\`\`` : kind === "prose" ? `Here are the answers:\n${json}\nEnd of answers.` : json);
    expect(await cleanFiles(input)).toMatchObject({ ok: true });
    const grade = engine.propose.mock.calls.findLast(([prompt]) => prompt.startsWith("[memory-clean:grade]"))![0];
    expect(JSON.parse(grade.slice(grade.indexOf("\n\n") + 2))[0].actual).toBe(String(answers[0]));
  });

  it.each(["propose", "side", "questions", "answers", "grade"])("enforces the prompt budget before %s", async (stage) => {
    const engine = calls();
    const memory = stage === "propose" ? "x".repeat(240_000) : "- kept\n- old\n";
    const side = stage === "side" || stage === "questions" ? { file: "memory/topic.md" as const, text: `- kept\n- old\n${"x".repeat(stage === "side" ? 480_000 : 245_000)}` } : undefined;
    if (stage === "grade") engine.recall.mockResolvedValue(JSON.stringify(["x".repeat(240_000), ...questions().slice(1).map((q) => q.answer)]));
    const result = await cleanFiles({ memory, side, history: stage === "answers" ? "x".repeat(240_000) : null, typed: new Set(), ...engine });
    expect(result).toEqual({ ok: false, stage: "nothing", detail: "budget" });
    expect(engine.propose.mock.calls.length + engine.recall.mock.calls.length).toBe({ propose: 0, side: 1, questions: 2, answers: 2, grade: 3 }[stage]);
    expect([...engine.propose.mock.calls, ...engine.recall.mock.calls].reduce((sum, [prompt]) => sum + Math.ceil(prompt.length / 4), 0)).toBeLessThanOrEqual(side ? 120_000 : 60_000);
  });

  it("archives raw lines and uses blind fresh answers with a signal on every call", async () => {
    const engine = calls();
    const signal = new AbortController().signal;
    const result = await cleanFiles({ memory: "- Never delete\r\n- old\r\n- kept\r\n", history: null, typed: new Set(), ...engine, signal, now: NOW });
    expect(result).toMatchObject({ ok: true, recall: { asked: 18, passed: 18, wrong: 0 } });
    if (!result.ok) return;
    expect(parseHistory(result.block)[0]?.entries[0]?.lines).toEqual(["- old\r"]);
    expect(result.memory.split(POINTER_LINE)).toHaveLength(2);
    expect(engine.recall.mock.calls[0]![0]).not.toContain('"answer":');
    for (const [, opts] of [...engine.propose.mock.calls, ...engine.recall.mock.calls]) expect(opts).toMatchObject({ signal, timeoutMs: 120000 });
  });

  it.each(["wrong", "malformed", "coverage", "absent"])("fails closed on %s recall", async (mode) => {
    const engine = calls();
    if (mode === "wrong") engine.propose.mockImplementation(async (prompt) => prompt.includes("[memory-clean:grade]") ? JSON.stringify(Array(18).fill(false)) : prompt.includes("[memory-clean:questions]") ? JSON.stringify(questions()) : JSON.stringify({ version: 1, file: "MEMORY.md", changes: [retire(2)] }));
    if (mode === "malformed") engine.recall.mockResolvedValue("bad");
    if (mode === "coverage") engine.propose.mockResolvedValueOnce(JSON.stringify({ version: 1, file: "MEMORY.md", changes: [retire(2)] })).mockResolvedValueOnce("[]");
    if (mode === "absent") engine.recall.mockResolvedValue(JSON.stringify(Array(18).fill("invented")));
    expect(await cleanFiles({ memory: "- kept\n- old\n", history: null, typed: new Set(), ...engine })).toMatchObject({ ok: false, stage: "recall" });
  });

  it("aborts during a text call", async () => {
    const controller = new AbortController();
    const engine = calls();
    engine.propose.mockImplementationOnce(async () => { controller.abort(); return "{}"; });
    expect(await cleanFiles({ memory: "- kept\n- old\n", history: null, typed: new Set(), ...engine, signal: controller.signal })).toMatchObject({ ok: false, stage: "aborted" });
    expect(engine.recall).not.toHaveBeenCalled();
  });

  it.each([
    ["- before\n- old\n- after\n", [retire(2)]],
    ["- before\r\n\r\n- old\r\n\r\n- after\r\n", [retire(3)]],
    ["- old", [retire(1)]],
    ["- old\r\n", [retire(1)]],
    ["- before\n- one\n- two\n- after", [{ op: "merge", ids: [2, 3], text: "- one two", reason: "Duplicate" }]],
    ["- before\n- one\n- middle\n- two\n- after", [{ op: "merge", ids: [4, 2], text: "- one two", reason: "Duplicate" }]],
    ["- old\n- new\n", [{ op: "replace", id: 1, newer: 2, reason: "Current" }]],
    [`- before\n- old\n${POINTER_LINE}\n`, [retire(2)]],
  ] as Array<[string, Change[]]>)("undo recovers exact original bytes: %s", async (memory, changes) => {
    const { undoText } = await import("./memory-clean-undo.ts");
    const engine = calls(changes);
    const result = await cleanFiles({ memory, history: null, typed: new Set(), ...engine, now: NOW });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(undoText("MEMORY.md", result.memory, parseHistory(result.block)[0]!).text).toBe(memory);
  });

  it("rotates a full archive, repoints once and undoes the pointer", async () => {
    const { undoText } = await import("./memory-clean-undo.ts");
    const memory = `- kept\n- old\n${POINTER_LINE}\n`;
    const result = await cleanFiles({ memory, history: "한".repeat(82_000), typed: new Set(), ...calls(), now: NOW });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.memory).toContain("memory/memory-history-2.md");
    expect(undoText("MEMORY.md", result.memory, parseHistory(result.block)[0]!).text).toBe(memory);
  });
});

describe("memory cleanup service", () => {
  let store: Store;
  let bot: ReturnType<Store["createBot"]>;
  let dataDir: string;
  let clock: number;
  let busy: boolean;
  let pending: boolean;
  let dropped: boolean;
  let engine: ReturnType<typeof calls>;
  let service: ReturnType<typeof createMemoryClean>;
  let available: boolean;
  let home: HomeInput;
  let engineKey: string;
  const state = () => JSON.parse(readFileSync(join(dataDir, "memory-clean.json"), "utf8")).bots[bot.id];
  const original = "- Never delete\r\n- completed\r\n" + Array.from({ length: 158 }, (_, i) => `- kept ${i}\r\n`).join("");
  const run = async () => { service.check(bot.id); clock += QUIET; service.tick(); await service.idle(); };
  const row = () => store.messagesFor(bot.threadId).find((message) => message.tool?.tidy);

  beforeEach(() => {
    clock = NOW; busy = false; pending = false; dropped = false; available = true;
    home = { device: "000000000001" }; engineKey = "own:model";
    dataDir = temps.make(join(scratch, "service-"));
    store = new Store(() => ({ instanceId: "codex", model: "gpt-6.1" }));
    for (const old of store.bots) store.deleteBot(old.id);
    bot = store.createBot();
    bot.memoryNotes = false;
    writeMemoryFile(bot.id, original);
    engine = calls();
    service = createMemoryClean({ store, dataDir, engine: async () => available ? { ...engine, key: engineKey } : null, busy: () => busy, pending: () => pending, dropped: () => dropped, home: () => home, now: () => clock });
    service.start();
  });

  afterEach(() => { service.dispose(); vi.useRealTimers(); });

  it.each(["nothing", "validate"])("waits for changed content and six hours after %s", async (outcome) => {
    engine = calls(outcome === "nothing" ? [] : [retire(1)]);
    await run();
    expect(engine.propose).toHaveBeenCalledTimes(1);
    for (let minute = 0; minute < 60; minute++) {
      clock += 60_000; service.tick(); await service.idle();
    }
    expect(engine.propose).toHaveBeenCalledTimes(1);
    clock += 6 * 60 * 60_000;
    service.dispose();
    service = createMemoryClean({ store, dataDir, engine: async () => engine, busy: () => false, pending: () => false, dropped: () => true, home: () => home, now: () => clock });
    service.start(); service.check(bot.id); service.tick(); await service.idle();
    expect(engine.propose).toHaveBeenCalledTimes(1);
    writeMemoryFile(bot.id, original + "- edit\n");
    await run();
    expect(engine.propose).toHaveBeenCalledTimes(2);
    writeMemoryFile(bot.id, original + "- next edit\n");
    await run();
    expect(engine.propose).toHaveBeenCalledTimes(2);
    clock += 6 * 60 * 60_000; service.tick(); await service.idle();
    expect(engine.propose).toHaveBeenCalledTimes(3);
  });

  it.each(["abort", "timeout"])("discards a late signal-ignoring call after %s", async (kind) => {
    vi.useFakeTimers();
    let finish: (text: string) => void = () => {};
    engine.propose.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    service.check(bot.id); clock += QUIET; service.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.propose).toHaveBeenCalledTimes(1);
    let settled = false;
    const idle = service.idle().then(() => { settled = true; });
    if (kind === "abort") service.turnStarted();
    else await vi.advanceTimersByTimeAsync(120_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    await idle;
    finish(JSON.stringify({ version: 1, file: "MEMORY.md", changes: [retire(2)] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(memoryFileRaw(bot.id)).toBe(original);
    expect(row()).toBeUndefined();
    expect(existsSync(join(workspaceDir(bot.id), "memory/memory-history.md"))).toBe(false);
    expect(engine.recall).not.toHaveBeenCalled();
  });

  it("queues at both size thresholds without a model call and runs with Auto notes off", async () => {
    service.check(bot.id);
    expect(state().queued.reason).toBe("size");
    expect(engine.propose).not.toHaveBeenCalled();
    await run();
    expect(row()?.tool).toMatchObject({ spoken: "Tidied memory, nothing lost", tidy: { runId: expect.any(String) } });
    expect(row()?.tool?.lines).toBeUndefined();
    writeMemoryFile(bot.id, "x".repeat(19199)); service.check(bot.id); expect(state().queued).toBeUndefined();
    writeMemoryFile(bot.id, "x".repeat(19200)); service.check(bot.id); expect(state().queued).toBeDefined();
  });

  it("undo is byte-identical with no later edits and patches the same row", async () => {
    await run();
    const runId = row()!.tool!.tidy!.runId;
    expect(service.summary(bot.id).run).toMatchObject({ runId, undoable: true });
    expect(await service.undo(bot.id, runId)).toMatchObject({ ok: true, restored: 1, skipped: 0 });
    expect(memoryFileRaw(bot.id)).toBe(original);
    expect(store.messagesFor(bot.threadId).filter((message) => message.tool?.tidy)).toHaveLength(1);
    expect(row()?.tool).toMatchObject({ spoken: "Memory cleanup undone", tidy: { runId, undoneAt: clock } });
    expect(service.summary(bot.id).run).toMatchObject({ undoable: false, undoneAt: clock });
    expect(await service.undo(bot.id, runId)).toEqual({ ok: false, error: "undone" });
  });

  it("preserves an edited replacement and counts its old lines as skipped", async () => {
    engine = calls([{ op: "merge", ids: [2, 3], text: "- completed kept 0", reason: "Same subject" }]);
    await run();
    const runId = row()!.tool!.tidy!.runId;
    writeMemoryFile(bot.id, memoryFileRaw(bot.id).replace("- completed kept 0", "- edited by user"));
    expect(await service.undo(bot.id, runId)).toMatchObject({ ok: true, restored: 0, skipped: 2 });
    expect(memoryFileRaw(bot.id)).toContain("- edited by user");
  });

  it("restores beside old neighbors while preserving unrelated later edits", async () => {
    await run();
    const runId = row()!.tool!.tidy!.runId;
    writeMemoryFile(bot.id, memoryFileRaw(bot.id).replace("- kept 7", "- user changed 7"));
    expect(await service.undo(bot.id, runId)).toMatchObject({ ok: true, restored: 1, skipped: 0 });
    expect(memoryFileRaw(bot.id)).toBe(original.replace("- kept 7", "- user changed 7"));
  });

  it.each(["memory", "archive", "turn", "typed", "touch"])("fences %s changing between propose and write", async (kind) => {
    const originalCall = engine.propose.getMockImplementation()!;
    engine.propose.mockImplementation(async (prompt, opts) => {
      if (prompt.startsWith("[memory-clean:questions]")) {
        if (kind === "memory") writeMemoryFile(bot.id, original + "- concurrent\n");
        if (kind === "archive") { mkdirSync(join(workspaceDir(bot.id), "memory"), { recursive: true }); writeFileSync(join(workspaceDir(bot.id), "memory/memory-history.md"), "concurrent\n"); }
        if (kind === "turn") service.turnStarted();
        if (kind === "touch") service.touch(bot.id);
        if (kind === "typed") (await import("./memory-clean.ts")).recordTypedLines(bot.id, "", "- newly typed", dataDir);
      }
      return originalCall(prompt, opts);
    });
    await run();
    expect(row()).toBeUndefined();
    expect(memoryFileRaw(bot.id)).toBe(kind === "memory" ? original + "- concurrent\n" : original);
    const path = join(workspaceDir(bot.id), "memory/memory-history.md");
    expect(existsSync(path)).toBe(kind === "archive");
    if (kind === "turn" || kind === "touch") expect(engine.propose.mock.calls.some(([, opts]) => opts?.signal?.aborted)).toBe(true);
  });

  it.each(["busy", "pending", "signed-out", "editor", "user"])("waits for %s to clear", async (kind) => {
    service.check(bot.id); clock += QUIET;
    if (kind === "busy") busy = true;
    if (kind === "pending") pending = true;
    if (kind === "signed-out") available = false;
    if (kind === "editor") service.touch(bot.id);
    if (kind === "user") store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi" });
    service.tick(); await service.idle();
    expect(engine.propose).not.toHaveBeenCalled();
    busy = false; pending = false; available = true; clock += QUIET;
    service.tick(); await service.idle();
    expect(row()).toBeDefined();
  });

  it("respects cooldown and a dropped note skips it", async () => {
    await run();
    const count = engine.propose.mock.calls.length;
    service.check(bot.id); service.tick(); await service.idle();
    expect(engine.propose).toHaveBeenCalledTimes(count);
    dropped = true; await run();
    expect(engine.propose).toHaveBeenCalledTimes(count);
    clock += 6 * 60 * 60_000; await run();
    expect(engine.propose.mock.calls.length).toBeGreaterThan(count);
  });

  it("backs off failed recall for 14 days even when notes are dropped", async () => {
    engine.recall.mockResolvedValue("bad");
    await run();
    expect(state().backoff["MEMORY.md"]).toBe(clock + 14 * DAY);
    const count = engine.propose.mock.calls.length;
    dropped = true; clock += DAY; await run();
    expect(engine.propose).toHaveBeenCalledTimes(count);
    clock += 14 * DAY; await run();
    expect(engine.propose.mock.calls.length).toBeGreaterThan(count);
  });

  it("checks daily and never starts until explicitly started", async () => {
    service.dispose();
    service = createMemoryClean({ store, dataDir, engine: async () => engine, busy: () => false, pending: () => false, dropped: () => false, home: () => ({ device: "000000000001" }), now: () => clock });
    clock += DAY; service.tick(); await service.idle(); expect(engine.propose).not.toHaveBeenCalled();
    service.start(); service.tick(); await service.idle(); expect(row()).toBeDefined();
  });

  it("cleans only the largest pointed, changed side file per run", async () => {
    const small = `- head\n- completed\n${"s".repeat(49000)}\n`;
    const large = `- head\n- completed\n${"l".repeat(51000)}\n`;
    const unpointed = `- head\n- completed\n${"u".repeat(60000)}\n`;
    writeMemoryFile(bot.id, original + "- memory/small.md: details\n- memory/large.md: details\n");
    writeFileSync(join(workspaceDir(bot.id), "memory/small.md"), small);
    writeFileSync(join(workspaceDir(bot.id), "memory/large.md"), large);
    writeFileSync(join(workspaceDir(bot.id), "memory/unpointed.md"), unpointed);
    await run();
    expect(service.summary(bot.id).run?.files).toEqual(["MEMORY.md", "memory/large.md"]);
    expect(readFileSync(join(workspaceDir(bot.id), "memory/small.md"), "utf8")).toBe(small);
    expect(readFileSync(join(workspaceDir(bot.id), "memory/unpointed.md"), "utf8")).toBe(unpointed);
    expect(state().sideHashes["memory/large.md"]).toMatch(/^[0-9a-f]{64}$/);
    dropped = true; clock += 6 * 60 * 60_000; engine.propose.mockClear(); await run();
    expect(engine.propose.mock.calls.filter(([prompt]) => prompt.startsWith("[memory-clean:propose]")).map(([prompt]) => /"file":"([^"]+)"/.exec(prompt)?.[1])).toEqual(["MEMORY.md", "memory/small.md"]);
  });

  it("fences a concurrent side-file write", async () => {
    const memory = original + "- memory/topic.md: details\n";
    const side = `- head\n- completed\n${"s".repeat(49000)}\n`;
    const path = join(workspaceDir(bot.id), "memory/topic.md");
    writeMemoryFile(bot.id, memory); writeFileSync(path, side);
    const call = engine.propose.getMockImplementation()!;
    engine.propose.mockImplementation(async (prompt, opts) => {
      if (prompt.startsWith("[memory-clean:questions]")) writeFileSync(path, side + "- concurrent\n");
      return call(prompt, opts);
    });
    await run();
    expect(memoryFileRaw(bot.id)).toBe(memory); expect(readFileSync(path, "utf8")).toBe(side + "- concurrent\n");
    expect(row()).toBeUndefined(); expect(existsSync(join(workspaceDir(bot.id), "memory/memory-history.md"))).toBe(false);
  });

  it.each(["signed-out", "selection", "home", "snapshot", "pending"])("rechecks %s before writing", async (kind) => {
    const folder = temps.make(join(scratch, "home-"));
    const root = join(folder, "memory-v2", "b"); mkdirSync(root, { recursive: true });
    const snapshot = join(root, "000000000001.json");
    writeFileSync(snapshot, JSON.stringify({ device: "000000000001", talkedAt: 1 }));
    home = { folder, botSyncId: "b", device: "000000000001", talkedAt: 1 };
    const call = engine.propose.getMockImplementation()!;
    engine.propose.mockImplementation(async (prompt, opts) => {
      if (prompt.startsWith("[memory-clean:grade]")) {
        if (kind === "signed-out") available = false;
        if (kind === "selection") engineKey = "other:model";
        if (kind === "home") writeFileSync(join(root, "000000000002.json"), JSON.stringify({ device: "000000000002", talkedAt: 2 }));
        if (kind === "snapshot") writeFileSync(snapshot, JSON.stringify({ device: "000000000001", talkedAt: 1, files: { version: 2 } }));
        if (kind === "pending") pending = true;
      }
      return call(prompt, opts);
    });
    await run();
    expect(memoryFileRaw(bot.id)).toBe(original); expect(row()).toBeUndefined();
    expect(existsSync(join(workspaceDir(bot.id), "memory/memory-history.md"))).toBe(false);
  });

  it("protects typed hashes from every snapshot and leaves malformed typed lists readable", async () => {
    const { lineHash } = await import("./memory-clean.ts");
    const folder = temps.make(join(scratch, "typed-"));
    const root = join(folder, "memory-v2", "b"); mkdirSync(root, { recursive: true });
    const other = join(root, "000000000002.json");
    writeFileSync(other, JSON.stringify({ device: "000000000002", talkedAt: 0, typed: [lineHash("- completed")] }));
    home = { folder, botSyncId: "b", device: "000000000001", talkedAt: 1 };
    await run(); expect(row()).toBeUndefined(); expect(engine.recall).not.toHaveBeenCalled();
    writeFileSync(other, JSON.stringify({ device: "000000000002", talkedAt: 0, typed: ["invalid"] }));
    writeMemoryFile(bot.id, original + "\r\n"); clock += 6 * 60 * 60_000;
    await run(); expect(row()).toBeDefined();
  });

  it("does not let an unavailable first bot starve the next queued bot", async () => {
    const next = store.createBot(); writeMemoryFile(next.id, original);
    service.dispose();
    service = createMemoryClean({ store, dataDir, engine: async (id) => id === bot.id ? null : engine, busy: () => false, pending: () => false, dropped: () => false, home: () => home, now: () => clock });
    service.start(); service.check(bot.id); service.check(next.id); clock += QUIET;
    service.tick(); await service.idle(); service.tick(); await service.idle();
    expect(store.messagesFor(next.threadId).some((message) => message.tool?.tidy)).toBe(true);
  });

  it("offers only the newest run for Undo and reports busy and absent runs", async () => {
    expect(service.summary(bot.id)).toEqual({ run: null });
    expect(await service.undo(bot.id, "absent")).toEqual({ ok: false, error: "no-run" });
    busy = true; expect(await service.undo(bot.id, "absent")).toEqual({ ok: false, error: "busy" }); busy = false;
    await run(); const first = service.summary(bot.id).run!.runId;
    dropped = true; clock += 6 * 60 * 60_000; await run(); const newest = service.summary(bot.id).run!.runId;
    expect(newest).not.toBe(first);
    expect(await service.undo(bot.id, first)).toEqual({ ok: false, error: "not-newest" });
    expect(await service.undo(bot.id, newest)).toMatchObject({ ok: true });
    expect(await service.undo(bot.id, newest)).toEqual({ ok: false, error: "undone" });
  });

  it("honors a synced run's cooldown when this PC has no local run state", async () => {
    await run(); const count = engine.propose.mock.calls.length;
    service.dispose(); dataDir = temps.make(join(scratch, "new-pc-"));
    service = createMemoryClean({ store, dataDir, engine: async () => engine, busy: () => false, pending: () => false, dropped: () => dropped, home: () => home, now: () => clock });
    service.start(); service.check(bot.id); clock += QUIET; service.tick(); await service.idle();
    expect(engine.propose).toHaveBeenCalledTimes(count);
    dropped = true; service.check(bot.id); service.tick(); await service.idle();
    expect(engine.propose).toHaveBeenCalledTimes(count);
    clock += 6 * 60 * 60_000; service.tick(); await service.idle();
    expect(engine.propose.mock.calls.length).toBeGreaterThan(count);
  });
});
