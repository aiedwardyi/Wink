import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAskPrs } from "./ask-prs.ts";
import { createDreamLive, landings, type DreamPlan } from "./dream-live.ts";
import type { NoteGenerator } from "./memory-pass.ts";
import { createMemorySleep, planTidy, SLEEP_GAP_MS, SLEEP_IDLE_MS, type MemorySleep } from "./memory-sleep.ts";
import { isOpenAsk, type TaskAsk } from "./task-asks.ts";
import { TASK_STATE_MAX_BYTES, type TaskResumePacket } from "./task-state.ts";
import { loadedMemory, MEMORY_MAX_LINES, memoryFileRaw, workspaceDir, writeMemoryFile } from "./workspace.ts";
import { createTempDirs } from "./testing/cleanup.ts";

type GhView = { state: "MERGED" | "OPEN"; mergedAt?: string | null };
const temps = createTempDirs();
afterAll(() => temps.remove());
const NOW = new Date(2026, 10, 25, 12).getTime();
const DAY = 24 * 60 * 60_000;
const memory = (...lines: string[]) => `# Memory\n\n${lines.join("\n")}\n`;
const reply = (value: Record<string, unknown>): NoteGenerator => async () => JSON.stringify(value);
const ask = (id: number, overrides: Partial<TaskAsk> = {}): TaskAsk => ({ id: `A${id}`, ask: `ask ${id}`, status: "building", at: NOW - 5 * DAY, changedAt: NOW - 5 * DAY, ...overrides });
const packet = (threadId: string, asks: TaskAsk[], extra: Partial<TaskResumePacket> = {}): TaskResumePacket => ({
  v: 1, threadId, botId: "bot", goal: "Ship it", plan: [], completed: [], evidence: [], artifacts: [], blockers: [], nextAction: "",
  updatedAt: NOW, updatedBy: "bot", flushReason: "turn-end", turnsAtWrite: 0, asks, ...extra,
});
const closedBytes = (record: TaskResumePacket) => Buffer.byteLength(JSON.stringify({ ...record, asks: record.asks?.filter((each) => !isOpenAsk(each)) }, null, 2), "utf8");
// completed and evidence up to `room` bytes under the 16 KB budget, inside their item caps
function nearlyFull(record: TaskResumePacket, room: number): TaskResumePacket {
  const fits = (next: TaskResumePacket) => closedBytes(next) <= TASK_STATE_MAX_BYTES - room;
  let full: TaskResumePacket = { ...record, completed: Array.from({ length: 30 }, (_, n) => ({ note: `${n}`.padEnd(280, "c"), at: NOW })) };
  const item = (n: number, size = 400) => ({ kind: "file" as const, ref: `${n}`.padEnd(size, "x") });
  while (full.evidence.length < 29 && fits({ ...full, evidence: [...full.evidence, item(full.evidence.length)] })) full = { ...full, evidence: [...full.evidence, item(full.evidence.length)] };
  let size = 2;
  while (size < 500 && fits({ ...full, evidence: [...full.evidence, item(99, size + 1)] })) size += 1;
  return { ...full, evidence: [...full.evidence, item(99, size)] };
}

describe("planTidy loads the newest lines too", () => {
  it("never moves a loaded tail note out for a copy in the cut middle", () => {
    const filler = Array.from({ length: MEMORY_MAX_LINES + 200 }, (_, n) => `- Filler kettle${n} harbor${n} lantern${n}`);
    filler[MEMORY_MAX_LINES] = "- Uses pnpm (noted 2026-11-10)";
    const raw = memory(...filler, "- Uses pnpm (noted 2026-11-01)");
    const view = loadedMemory(raw);
    expect(view.newest).toContain("- Uses pnpm (noted 2026-11-01)");
    expect(view.text).not.toContain("- Uses pnpm (noted 2026-11-10)");
    expect(planTidy(raw).map(({ text, by }) => [text, by])).toEqual([["- Uses pnpm (noted 2026-11-10)", "- Uses pnpm (noted 2026-11-01)"]]);
  });

  // the newest lines roll out of the prompt as notes are added; the head stays
  it("keeps the head copy of a note that also sits in the newest lines", () => {
    const head = (top: string, bottom: string) => {
      const filler = Array.from({ length: MEMORY_MAX_LINES + 220 }, (_, n) => `- Filler kettle${n} harbor${n} lantern${n}`);
      filler[2] = top;
      const raw = memory(...filler, bottom);
      const view = loadedMemory(raw);
      expect(view.text).toContain(top);
      expect(view.newest).toContain(bottom);
      return raw;
    };
    const twin = head("- Deploys with pnpm from the home PC (noted 2026-10-01)", "- Deploys with pnpm from the home PC (noted 2026-11-20)");
    expect(planTidy(twin).map(({ text, by }) => [text, by])).toEqual([["- Deploys with pnpm from the home PC (noted 2026-11-20)", "- Deploys with pnpm from the home PC (noted 2026-10-01)"]]);
    const model = head("- Deploys with pnpm (noted 2026-10-01)", "- Deploys with pnpm and turbo from the home PC (noted 2026-11-20)");
    expect(planTidy(model, JSON.stringify({ duplicates: [{ keep: `L${MEMORY_MAX_LINES + 223}`, drop: ["L5"] }] }))).toEqual([]);
    const replaced = head("- Prefers tabs (noted 2026-10-01)", "- Prefers spaces, not tabs (noted 2026-11-20)");
    expect(planTidy(replaced, JSON.stringify({ disagree: [["L5", `L${MEMORY_MAX_LINES + 223}`]] })).map(({ text }) => text)).toEqual(["- Prefers tabs (noted 2026-10-01)"]);
  });
});

describe("replaces keeps a fact a hedged or scoped newer note only narrows", () => {
  it.each([
    ["- Lives in Seoul (noted 2026-10-01)", "- Lives in Busan, maybe not Seoul (noted 2026-11-12)"],
    ["- Prefers tabs (noted 2026-10-01)", "- Prefers spaces over tabs (noted 2026-11-12)"],
    ["- Replies in English (noted 2026-10-01)", "- Replies in English except when I write Korean (noted 2026-11-12)"],
    ["- Ships on Fridays (noted 2026-10-01)", "- Ships on Fridays unless the build is red (noted 2026-11-12)"],
    ["- Ships on Fridays (noted 2026-10-01)", "- Ships on Fridays except when not ready (noted 2026-11-12)"],
    ["- Uses pnpm (noted 2026-10-01)", "- Uses pnpm, but perhaps bun later (noted 2026-11-12)"],
  ])("%s stays beside %s", (older, newer) => {
    expect(planTidy(memory(older, newer), JSON.stringify({ disagree: [["L3", "L4"]] }))).toEqual([]);
  });

  it("still retires a note a newer one plainly turns", () => {
    expect(planTidy(memory("- Lives in Seoul (noted 2026-10-01)", "- Lives in Busan, not Seoul (noted 2026-11-12)"), JSON.stringify({ disagree: [["L3", "L4"]] }))).toHaveLength(1);
  });
});

describe("askPrs.merged", () => {
  it("reads when each PR merged, for any status, and holds back an open or unchecked one", async () => {
    const states: Record<string, GhView> = { "10": { state: "MERGED", mergedAt: "2026-11-24T10:00:00Z" }, "11": { state: "OPEN", mergedAt: null } };
    const prs = createAskPrs({ repoDir: () => "C:/repo", gh: async (_cwd, args) => JSON.stringify(states[args[2]!]) });
    const open = ask(1, { status: "open", ref: "PR 10" });
    expect(prs.merged("bot", "t", open, true)).toBeUndefined();
    prs.merged("bot", "t", ask(2, { ref: "PR 11" }), true);
    await prs.settled();
    expect(prs.merged("bot", "t", open)).toEqual([{ number: 10, mergedAt: Date.parse("2026-11-24T10:00:00Z") }]);
    expect(prs.merged("bot", "t", ask(2, { ref: "PR 11" }))).toBeNull();
    expect(prs.merged("bot", "t", ask(3, { ref: "PR 10 and PR 11" }))).toBeNull();
  });
});

describe("landings", () => {
  it("says a close on a packet with no room leaves the to-do file now", () => {
    const record = nearlyFull(packet("t", [ask(1, { ref: "PR 10" }), ask(2, { status: "open" })]), 40);
    expect(landings(record, ["A1"], NOW).lands("A1")).toBe("leaves-now");
  });

  it("names the closed asks a close pushes out of the budget", () => {
    const record = nearlyFull(packet("t", [ask(1, { status: "done", ask: "Old done one" }), ask(2, { ref: "PR 10" })]), 40);
    const landed = landings(record, ["A2"], NOW);
    expect(landed.lands("A2")).toBe("stays");
    expect(landed.fallOut.map((each) => each.id)).toEqual(["A1"]);
  });

  it("says a close past the 40-ask cap leaves at the bot's next update, and one under it stays", () => {
    const open = Array.from({ length: 40 }, (_, n) => ask(n + 2, { status: "open" }));
    expect(landings(packet("t", [ask(1, { ref: "PR 10" }), ...open]), ["A1"], NOW).lands("A1")).toBe("leaves-next");
    expect(landings(packet("t", [ask(1, { ref: "PR 10" }), ...open.slice(1)]), ["A1"], NOW).lands("A1")).toBe("stays");
  });
});

describe("dreaming, dry", () => {
  let dataDir: string;
  let packets: Map<string, TaskResumePacket>;
  let pending: Map<string, TaskResumePacket>;
  let gh: Record<string, GhView>;
  let reverts: Set<number>;
  let enabled: boolean;
  let busy: Set<string>;
  let generator: NoteGenerator;
  let generate: ReturnType<typeof vi.fn<NoteGenerator>>;
  let hold: Promise<void> | undefined;
  let changed: ReturnType<typeof vi.fn<(botId: string) => void>>;
  let bot: string;
  let seq = 0;
  let sleep: MemorySleep;

  const setMode = (bots: Record<string, string>) => writeFileSync(join(dataDir, "dream-live.json"), JSON.stringify({ bots }));
  const start = () => {
    const askPrs = createAskPrs({ repoDir: () => "C:/repo", gh: async (_cwd, args) => {
      const state = gh[args[2]!];
      if (!state) throw new Error("no pull requests found");
      return JSON.stringify(state);
    } });
    const dream = createDreamLive({
      dataDir,
      pc: () => "pc-1",
      threads: () => [...new Set([...packets.keys(), ...pending.keys()])],
      packet: (threadId) => pending.get(threadId) ?? packets.get(threadId) ?? null,
      busy: (_botId, threadId) => busy.has(threadId),
      cite: async () => {},
      merged: (botId, threadId, item, begin) => askPrs.merged(botId, threadId, item, begin),
      checked: async () => {
        await askPrs.settled();
        await hold;
      },
      reverted: async () => (pr) => reverts.has(pr),
    });
    return { dream, sleep: createMemorySleep({ dataDir, bots: () => [bot], generate: () => generate, enabled: () => enabled, busy: () => false, changed, dream }) };
  };
  const quiet = async (wait = SLEEP_IDLE_MS) => {
    await vi.advanceTimersByTimeAsync(wait);
    await sleep.idle();
  };
  const plans = (): DreamPlan[] => {
    const dir = join(dataDir, "dream-live", "runs", bot);
    try {
      // SAFETY: the pass under test wrote these through planSchema
      return readdirSync(dir).map((runId) => JSON.parse(readFileSync(join(dir, runId, "plan.json"), "utf8")) as DreamPlan).sort((left, right) => right.at - left.at);
    } catch {
      return [];
    }
  };
  const history = () => {
    try {
      return readFileSync(join(workspaceDir(bot), "memory-history", "2026-11.md"), "utf8");
    } catch {
      return "";
    }
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(console, "info").mockImplementation(() => {});
    dataDir = temps.make(join(tmpdir(), "dream-live-"));
    bot = `dream-bot-${++seq}`;
    packets = new Map();
    pending = new Map();
    gh = {};
    reverts = new Set();
    enabled = true;
    busy = new Set();
    generator = reply({});
    generate = vi.fn<NoteGenerator>((...args) => generator(...args));
    hold = undefined;
    changed = vi.fn();
    setMode({ [bot]: "dry" });
    sleep = start().sleep;
  });

  afterEach(() => {
    sleep.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("closes only building asks whose PRs all merged after the ask changed and stayed merged, and only asks about an open one", async () => {
    const merged = (iso: string): GhView => ({ state: "MERGED", mergedAt: iso });
    gh = { "10": merged("2026-11-24T10:00:00Z"), "11": merged("2026-11-24T10:00:00Z"), "12": merged("2026-11-01T10:00:00Z"), "13": merged("2026-11-24T10:00:00Z"), "14": { state: "OPEN" } };
    reverts = new Set([13]);
    const asks = [
      ask(1, { ref: "PR 10" }),
      ask(2, { status: "open", ref: "PR 11", ask: "Verify PR 11 after merge" }),
      ask(3, { ref: "PR 12" }),
      ask(4, { ref: "PR 13" }),
      ask(5, { ref: "PR 10 + PR 14" }),
      ask(6, { status: "waiting-for-user", ref: "PR 10" }),
      ask(7, { ref: "PR 10", until: NOW + DAY, status: "open" }),
    ];
    packets.set("t1", packet("t1", asks));
    const before = JSON.stringify(packets.get("t1"));
    await quiet();
    const items = plans()[0]!.asks.items;
    expect(items.map(({ op, target }) => [op, target])).toEqual([["ask", "ask:t1:A2"], ["close", "ask:t1:A1"]]);
    expect(items[1]).toMatchObject({ lands: "stays", prs: [{ number: 10, mergedAt: Date.parse("2026-11-24T10:00:00Z") }] });
    expect(JSON.stringify(packets.get("t1"))).toBe(before);
  });

  it("reads asks the way the next write would, pending buffer included", async () => {
    gh = { "10": { state: "MERGED", mergedAt: "2026-11-24T10:00:00Z" } };
    packets.set("t1", packet("t1", [ask(1, { status: "open" })]));
    pending.set("t1", packet("t1", [ask(1, { ref: "PR 10" })]));
    await quiet();
    expect(plans()[0]!.asks.items.map(({ op }) => op)).toEqual(["close"]);
  });

  it("keeps the close line on disk with the plan, and owed lines survive a restart until told", async () => {
    gh = { "10": { state: "MERGED", mergedAt: "2026-11-24T10:00:00Z" } };
    packets.set("t1", packet("t1", [ask(1, { ref: "PR 10", ask: "Fix the sidebar picker" })]));
    await quiet();
    const plan = plans()[0]!;
    expect(plan.asks.items[0]).toMatchObject({ notice: '[Wink closed A1 "Fix the sidebar picker": PR 10 merged. Its ref was "PR 10".]', told: false });
    const dir = join(dataDir, "dream-live", "runs", bot, plan.runId);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ runId: plan.runId, botId: bot, at: plan.at, items: plan.asks.items }));
    const restarted = start().dream;
    expect(restarted.owed(bot, "t1").map(({ line }) => line)).toEqual([plan.asks.items[0]!.notice]);
    expect(restarted.owed(bot, "t2")).toEqual([]);
    restarted.told(bot, plan.runId, ["ask:t1:A1"]);
    expect(start().dream.owed(bot, "t1")).toEqual([]);
  });

  it("lists the notes Sleep would move with their history file, writing neither MEMORY.md nor the history", async () => {
    const raw = memory("- Prefers light mode (noted 2026-10-01)", "- Uses pnpm", "- Uses  pnpm.", "- Prefers dark mode, not light mode (noted 2026-11-12)");
    writeMemoryFile(bot, raw);
    generator = reply({ disagree: [["L3", "L6"]] });
    await quiet();
    expect(memoryFileRaw(bot)).toBe(raw);
    expect(history()).toBe("");
    expect(generate).toHaveBeenCalledTimes(1);
    const plan = plans()[0]!;
    expect(plan.notes.state).toBe("checked");
    expect(plan.notes.items.map(({ text, why, history: file }) => [text, why, file])).toEqual([
      ["- Prefers light mode (noted 2026-10-01)", "replaced", "memory-history/2026-11.md"],
      ["- Uses pnpm", "duplicate", "memory-history/2026-11.md"],
    ]);
    expect(plan.runUntil - plan.at).toBe(14 * DAY);
    expect(plan.dropUntil - plan.at).toBe(90 * DAY);
    sleep.onSettled(bot);
    await quiet(SLEEP_GAP_MS);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(plans()).toHaveLength(2);
    expect(plans()[0]!.notes).toEqual({ state: "unchanged", items: plan.notes.items });
  });

  it("keeps the last checked moves through a pass that skipped notes, under the month the reused plan runs in", async () => {
    writeMemoryFile(bot, memory("- Uses pnpm", "- Uses  pnpm."));
    await quiet();
    expect(plans()[0]!.notes.items).toHaveLength(1);
    enabled = false;
    sleep.onSettled(bot);
    await quiet(SLEEP_GAP_MS);
    expect(plans()[0]!.notes).toEqual({ state: "off-here", items: [] });
    enabled = true;
    vi.setSystemTime(new Date(2026, 11, 2, 12));
    sleep.onSettled(bot);
    await quiet(SLEEP_GAP_MS);
    expect(plans()[0]!.notes.state).toBe("unchanged");
    expect(plans()[0]!.notes.items.map(({ text, history: file }) => [text, file])).toEqual([["- Uses pnpm", "memory-history/2026-12.md"]]);
  });

  it("tells an open Memory page each time a dry plan is saved", async () => {
    await quiet();
    expect(plans()).toHaveLength(1);
    expect(changed).toHaveBeenCalledWith(bot);
  });

  it("copies no note that may hold a login, and redacts the rest", async () => {
    writeMemoryFile(bot, memory("- Wifi password is SunnyHarbor!42", "- Wifi password is SunnyHarbor!42"));
    await quiet();
    const plan = plans()[0]!;
    expect(plan.notes.items).toHaveLength(1);
    expect(plan.notes.items[0]).toMatchObject({ text: null, by: null });
    expect(readFileSync(join(dataDir, "dream-live", "runs", bot, plan.runId, "plan.json"), "utf8")).not.toContain("SunnyHarbor");
  });

  it("runs the asks part with Auto Notes off on this PC and says notes were not checked here", async () => {
    enabled = false;
    gh = { "10": { state: "MERGED", mergedAt: "2026-11-24T10:00:00Z" } };
    packets.set("t1", packet("t1", [ask(1, { ref: "PR 10" })]));
    writeMemoryFile(bot, memory("- Uses pnpm", "- Uses  pnpm."));
    await quiet();
    expect(plans()).toHaveLength(1);
    expect(plans()[0]!.notes).toEqual({ state: "off-here", items: [] });
    expect(plans()[0]!.asks.items).toHaveLength(1);
    expect(generate).not.toHaveBeenCalled();
    expect(memoryFileRaw(bot)).toBe(memory("- Uses pnpm", "- Uses  pnpm."));
  });

  it("writes nothing when a turn starts during the gh wait, and waits out the gap", async () => {
    gh = { "10": { state: "MERGED", mergedAt: "2026-11-24T10:00:00Z" } };
    packets.set("t1", packet("t1", [ask(1, { ref: "PR 10" })]));
    let release!: () => void;
    hold = new Promise((resolve) => (release = resolve));
    await vi.advanceTimersByTimeAsync(SLEEP_IDLE_MS);
    sleep.onTurn(bot);
    release();
    await sleep.idle();
    expect(plans()).toEqual([]);
    expect(vi.mocked(console.info).mock.calls.some(([line]) => String(line).includes('"result":"cancelled"'))).toBe(true);
    hold = undefined;
    sleep.onSettled(bot);
    await quiet();
    expect(plans()).toEqual([]);
    await quiet(SLEEP_GAP_MS);
    expect(plans()).toHaveLength(1);
  });

  it("skips a thread with a running turn and counts it", async () => {
    gh = { "10": { state: "MERGED", mergedAt: "2026-11-24T10:00:00Z" } };
    packets.set("t1", packet("t1", [ask(1, { ref: "PR 10" })]));
    busy.add("t1");
    await quiet();
    expect(plans()[0]!.asks).toMatchObject({ threads: 1, skipped: 1, items: [] });
  });

  it("leaves a bot with no entry, or one set to live, to today's tidy and writes no plan", async () => {
    for (const mode of [undefined, "live"]) {
      sleep.dispose();
      bot = `dream-bot-${++seq}`;
      setMode(mode ? { [bot]: mode } : {});
      sleep = start().sleep;
      writeMemoryFile(bot, memory("- Uses pnpm", "- Uses  pnpm."));
      await quiet();
      expect(memoryFileRaw(bot)).toBe(memory("- Uses  pnpm."));
      expect(plans()).toEqual([]);
    }
  });

  it("keeps a SIM follow-up to-do and a SIM note through a pass, and touches no SIM file", async () => {
    const extras = temps.make(join(tmpdir(), "orbit-extras-"));
    const ledger = join(extras, "sim-plan", "LEDGER.md");
    mkdirSync(join(extras, "sim-plan"), { recursive: true });
    writeFileSync(ledger, "# SIM ledger\n- try 2: 0.71\n");
    const ledgerAt = statSync(ledger).mtimeMs;
    gh = { "2185": { state: "MERGED", mergedAt: "2026-11-24T10:00:00Z" } };
    packets.set("t1", packet("t1", [ask(1, { status: "open", ask: "Log PR 2185's eval in the SIM ledger", ref: "PR 2185" })]));
    const before = JSON.stringify(packets.get("t1"));
    const raw = memory("- SIM try 2 passed the ledger check (noted 2026-11-20)", "- SIM try 2 passed the ledger check, but maybe not on Work (noted 2026-11-22)");
    writeMemoryFile(bot, raw);
    generator = reply({ disagree: [["L3", "L4"]] });
    await quiet();
    const plan = plans()[0]!;
    expect(plan.notes.items).toEqual([]);
    expect(plan.asks.items.map(({ op }) => op)).toEqual(["ask"]);
    expect(memoryFileRaw(bot)).toBe(raw);
    expect(JSON.stringify(packets.get("t1"))).toBe(before);
    expect(readFileSync(ledger, "utf8")).toBe("# SIM ledger\n- try 2: 0.71\n");
    expect(statSync(ledger).mtimeMs).toBe(ledgerAt);
  });

  it("sweeps plans past 14 days but never the newest", async () => {
    const dream = start().dream;
    const empty = { threads: 0, skipped: 0, unchecked: 0, items: [] };
    dream.plan(bot, NOW - 20 * DAY, { state: "off-here", moves: [] }, empty);
    expect(plans()).toHaveLength(1);
    dream.plan(bot, NOW - 15 * DAY, { state: "off-here", moves: [] }, empty);
    expect(plans().map(({ at }) => at)).toEqual([NOW - 15 * DAY]);
    dream.plan(bot, NOW, { state: "off-here", moves: [] }, empty);
    expect(plans().map(({ at }) => at)).toEqual([NOW]);
    expect(dream.latest(bot)).toMatchObject({ undoable: false, moved: 0, dream: { mode: "dry" } });
    setMode({});
    expect(dream.latest(bot)).toBeNull();
  });
});

describe("dreaming's wiring", () => {
  const index = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
  const call = index.slice(index.indexOf("createDreamLive({"), index.indexOf("// the same switch as Auto Notes"));

  it("reads asks through the 30 s buffer, never the store's own copy", () => {
    expect(call).toContain("packet: (threadId) => taskPacketForWrite(threadId)");
    expect(call).not.toMatch(/store\.(taskPacket|writeTaskPacket)\b/);
  });

  it("writes no packet in dry mode", () => {
    const source = readFileSync(join(import.meta.dirname, "dream-live.ts"), "utf8");
    expect(source).not.toMatch(/persistTaskPacket|writeTaskPacket|writeTaskResumePacket|stageTaskResumePacket/);
  });
});
