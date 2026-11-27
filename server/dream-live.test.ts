import { dreamedPath } from "./dream-archive.ts";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAskPrs } from "./ask-prs.ts";
import { sha8 } from "./memory-clean.ts";
import type { Message } from "./store.ts";
import { SAFETY_MEMORY } from "./testing/dream-safety.ts";
import { createDreamLive, landings, type DreamPlan } from "./dream-live.ts";
import type { NoteGenerator } from "./memory-pass.ts";
import { createMemorySleep, planTidy, SLEEP_GAP_MS, SLEEP_IDLE_MS, type MemorySleep } from "./memory-sleep.ts";
import { isOpenAsk, type TaskAsk } from "./task-asks.ts";
import { TASK_STATE_MAX_BYTES, type TaskResumePacket } from "./task-state.ts";
import { loadedMemory, MEMORY_MAX_LINES, memoryFileRaw, writeMemoryFile } from "./workspace.ts";
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
  let typed: Map<string, Message[]>;
  let waiting: boolean;
  // where each row sits in the store: one first read later was stored later
  const places = new WeakMap<Message, number>();
  let place = 0;
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
      threads: () => [...new Set([...packets.keys(), ...pending.keys(), ...typed.keys()])],
      rows: (threadId, since) => (typed.get(threadId) ?? []).filter((message) => message.at >= since),
      stored: (threadId) => (typed.get(threadId) ?? []).filter((message) => message.role === "user").map((message) => {
        if (!places.has(message)) places.set(message, ++place);
        return { ...message, row: places.get(message)! };
      }),
      under: (threadId, id) => {
        const rows = typed.get(threadId) ?? [];
        const below: string[] = [];
        for (let next = [id]; next.length; below.push(...next)) next = rows.filter((row) => row.parentId && next.includes(row.parentId)).map((row) => row.id);
        return below;
      },
      waiting: () => waiting,
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
    return { dream, sleep: createMemorySleep({ dataDir, bots: () => [bot], live: (botId) => dream.live(botId), judges: () => ({ claude: generate, gemini: async () => generate.mock.results.at(-1)!.value as Promise<string> }), enabled: () => enabled, busy: () => false, changed, dream }) };
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
      return readFileSync(dreamedPath(bot), "utf8");
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
    typed = new Map();
    waiting = false;
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
    generator = reply({ disagree: [["L3", "L6"]], repeat: [{ drop: "L4", by: ["L5"], lost: "" }] });
    await quiet();
    expect(memoryFileRaw(bot)).toBe(raw);
    expect(history()).toBe("");
    expect(generate).toHaveBeenCalledTimes(1);
    const plan = plans()[0]!;
    expect(plan.notes.state).toBe("checked");
    expect(plan.notes.items.map(({ text, why, history: file }) => [text, why, file])).toEqual([
      ["- Prefers light mode (noted 2026-10-01)", "replaced", "memory/dreamed.md"],
      ["- Uses pnpm", "duplicate", "memory/dreamed.md"],
    ]);
    expect(plan.runUntil - plan.at).toBe(14 * DAY);
    expect(plan.dropUntil - plan.at).toBe(90 * DAY);
    sleep.onSettled(bot);
    await quiet(SLEEP_GAP_MS);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(plans()).toHaveLength(2);
    expect(plans()[0]!.notes).toEqual({ state: "unchanged", items: plan.notes.items });
  });

  it("keeps the last checked moves through a pass that skipped notes", async () => {
    // all three passes on one day: a new day judges again, since a one-off can expire overnight
    vi.setSystemTime(new Date(2026, 10, 25, 0, 5));
    writeMemoryFile(bot, memory("- Uses pnpm", "- Uses  pnpm."));
    generator = reply({ repeat: [{ drop: "L3", by: ["L4"], lost: "" }] });
    await quiet();
    expect(plans()[0]!.notes.items).toHaveLength(1);
    enabled = false;
    sleep.onSettled(bot);
    await quiet(SLEEP_GAP_MS);
    expect(plans()[0]!.notes).toEqual({ state: "off-here", items: [] });
    enabled = true;
    sleep.onSettled(bot);
    await quiet(SLEEP_GAP_MS);
    expect(plans()[0]!.notes.state).toBe("unchanged");
    expect(plans()[0]!.notes.items.map(({ text, history: file }) => [text, file])).toEqual([["- Uses pnpm", "memory/dreamed.md"]]);
  });

  it("tells an open Memory page each time a dry plan is saved", async () => {
    await quiet();
    expect(plans()).toHaveLength(1);
    expect(changed).toHaveBeenCalledWith(bot);
  });

  it("copies no note that may hold a login, and redacts the rest", async () => {
    writeMemoryFile(bot, memory("- Wifi at home is SunnyHarbor!42", "- Wifi at home is SunnyHarbor!42"));
    generator = reply({ repeat: [{ drop: "L3", by: ["L4"], lost: "" }] });
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

  it("moves notes for a bot set to live and writes no plan", async () => {
    setMode({ [bot]: "live" });
    writeMemoryFile(bot, memory("- Uses pnpm", "- Uses  pnpm."));
    generator = reply({ repeat: [{ drop: "L3", by: ["L4"], lost: "" }] });
    await quiet();
    expect(memoryFileRaw(bot)).toBe(memory("- Uses  pnpm."));
    expect(plans()).toEqual([]);
  });

  // live tidy moves without an OK, so it reads only numeric days; written-out ones are for fixes the owner OKs
  it.each([
    ["10 Nov. 2027", false],
    ["November 10 to 30", false],
    ["10 to 30 November", false],
    ["November 2 to 10", false],
    ["November 10 to 12/02", false],
    ["November 10 through the 30th", false],
    ["November 10 next year", false],
    ["November 10, probably ending in December", false],
    ["November 10 to December 2", false],
    ["November 10 to November 25", false],
    ["November 10, 2027", false],
    ["11-02 to 12/02", false],
    ["11-02", true],
    ["2026-11-02", true],
  ])("live tidy moves a booking on %s only once every numeric day of it is past", async (date, moves) => {
    setMode({ [bot]: "live" });
    const raw = memory(`- The studio booking is for ${date} at the annex`, "- Bring the studio keys");
    writeMemoryFile(bot, raw);
    generator = reply({ stale: ["L3"] });
    await quiet();
    expect(memoryFileRaw(bot)).toBe(moves ? memory("- Bring the studio keys") : raw);
  });

  it.each([
    ["no mode file", () => rmSync(join(dataDir, "dream-live.json"), { force: true })],
    ["a mode file that is not JSON", () => writeFileSync(join(dataDir, "dream-live.json"), "{ bots: ")],
    ["a bot the list leaves out", () => setMode({ "another-bot": "live" })],
  ])("dreams dry with %s", async (_, set) => {
    set();
    const raw = memory("- Keeps tea in the blue tin", "- Dentist on 11-02 at 3pm");
    writeMemoryFile(bot, raw);
    generator = reply({ stale: ["L4"] });
    await quiet();
    expect(memoryFileRaw(bot)).toBe(raw);
    expect(history()).toBe("");
    expect(plans()[0]!.notes.items).toMatchObject([{ why: "expired" }]);
  });

  it("moves nothing when the bot is set to dry while its judges think", async () => {
    setMode({ [bot]: "live" });
    const raw = memory("- Keeps tea in the blue tin", "- Dentist on 11-02 at 3pm");
    writeMemoryFile(bot, raw);
    let answer: (text: string) => void = () => {};
    generator = () => new Promise((resolve) => (answer = resolve));
    await vi.advanceTimersByTimeAsync(SLEEP_IDLE_MS);
    expect(generate).toHaveBeenCalledTimes(1);
    setMode({ [bot]: "dry" });
    answer(JSON.stringify({ stale: ["L4"] }));
    await sleep.idle();
    expect(memoryFileRaw(bot)).toBe(raw);
    expect(history()).toBe("");
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

  describe("a note the owner's later words show wrong", () => {
    const OLD = "- The main account's plan ends in January (noted 2026-11-20)";
    const NEW = "- The main account's plan ends in March (noted 2026-11-20)";
    const RULE = '- ROOMS WORD (11-20): say rooms and Room Details to them in every user-facing string.';
    const raw = `${SAFETY_MEMORY}${OLD}\n${RULE}\n`.replace(/\n/g, "\r\n");
    const line = (text: string) => `L${raw.split("\r\n").indexOf(text) + 1}`;
    // SAFETY: the check reads only id, at, role, kind and text of a user row.
    const said = (id: string, at: number, text: string) => ({ id, at, role: "user", kind: "text", text }) as Message;
    const flags = (wrong: { note: string; quote: string; fix: string }[]): NoteGenerator => async (prompt) => {
      if (!prompt.includes("<pairs>")) return "{}";
      const refs = [...prompt.matchAll(/^PAIR\nL(\d+) [^\n]*\n(M\d+) /gm)].map(([, at, ref]) => [`L${at}`, ref!] as const);
      return JSON.stringify({ wrong: wrong.flatMap((flag) => refs.filter(([note]) => note === flag.note).map(([, message]) => ({ ...flag, message }))) });
    };
    // one message, the owner's newest, shows both notes wrong
    const M1 = "For the main account plan leave it. It lasts till march and thats my main account anyways. Also say groups instead in every user-facing string, we removed that name";
    beforeEach(() => {
      writeMemoryFile(bot, raw);
      typed.set("t1", [said("m1", NOW - DAY, M1)]);
      generator = flags([
        { note: line(OLD), quote: "It lasts till march", fix: NEW },
        { note: line(RULE), quote: "say groups instead in every user-facing string", fix: "- GROUPS WORD (11-20): say groups and Group Details to them in every user-facing string." },
      ]);
    });

    it("lists the fix with the owner's quote and changes nothing until that item's OK", async () => {
      await quiet();
      expect(memoryFileRaw(bot)).toBe(raw);
      expect(history()).toBe("");
      const plan = plans()[0]!;
      expect(plan.fixes).toMatchObject({ state: "checked", through: NOW + SLEEP_IDLE_MS });
      expect(plan.fixes!.items).toEqual([
        { op: "fix", target: `note:${sha8(OLD)}`, text: OLD, by: NEW, why: "wrong", listOnly: false, evidence: { thread: "t1", message: "m1", at: NOW - DAY, quote: "It lasts till march" }, seen: { at: NOW - DAY, sha: sha8(M1), ids: expect.stringMatching(/^[0-9a-f]{64}$/) } },
        expect.objectContaining({ text: RULE, listOnly: true, evidence: expect.objectContaining({ message: "m1" }) }),
      ]);
      expect(start().dream.latest(bot)!.dream.fixes).toEqual(plan.fixes);
      // the next pass reads only lines typed since, and keeps the list
      const calls = generate.mock.calls.length;
      sleep.onSettled(bot);
      await quiet(SLEEP_GAP_MS);
      expect(generate.mock.calls.length).toBe(calls);
      expect(plans()[0]!.fixes!.items).toEqual(plan.fixes!.items);
      expect(memoryFileRaw(bot)).toBe(raw);
    });

    it("swaps the line on OK with the old one archived, and Undo puts the exact bytes back", async () => {
      await quiet();
      const dream = start().dream;
      const { runId } = plans()[0]!;
      const target = `note:${sha8(OLD)}`;
      expect(dream.fix(bot, runId, `note:${sha8(RULE)}`, false)).toEqual({ ok: false, error: "list-only" });
      expect(dream.fix(bot, runId, target, true)).toEqual({ ok: false, error: "undone" });
      expect(memoryFileRaw(bot)).toBe(raw);
      expect(dream.fix(bot, runId, target, false)).toMatchObject({ ok: true });
      expect(memoryFileRaw(bot)).toBe(raw.replace(OLD, NEW));
      expect(history()).toContain(`${OLD}\n  - from MEMORY.md:${line(OLD).slice(1)} on 2026-11-25: the user wrote on 2026-11-24: "It lasts till march"`);
      expect(dream.fix(bot, runId, target, false)).toEqual({ ok: false, error: "done" });
      expect(plans()[0]!.fixes!.items[0]!.done).toMatchObject({ cr: true });
      expect(dream.fix(bot, runId, target, true)).toMatchObject({ ok: true });
      expect(Buffer.compare(Buffer.from(memoryFileRaw(bot)), Buffer.from(raw))).toBe(0);
      expect(history()).toMatch(/\(run [0-9a-f]{8}\), undone 2026-11-25\n/);
      expect(plans()[0]!.fixes!.items[0]!.done!.undoneAt).toBeDefined();
    });

    it("refuses an OK once the note changed, and on any plan but the newest", async () => {
      await quiet();
      const dream = start().dream;
      const { runId } = plans()[0]!;
      expect(dream.fix(bot, "0badc0de", `note:${sha8(OLD)}`, false)).toEqual({ ok: false, error: "not-newest" });
      writeMemoryFile(bot, raw.replace(OLD, "- The main account's plan ends in May (noted 2026-11-21)"));
      expect(dream.fix(bot, runId, `note:${sha8(OLD)}`, false)).toEqual({ ok: false, error: "changed" });
      expect(history()).toBe("");
    });

    const approve = (undo: boolean, id = plans()[0]!.runId) => start().dream.fix(bot, id, `note:${sha8(OLD)}`, undo);

    it("keeps one OK per item across two windows and a reload, and Undo keeps a later edit", async () => {
      await quiet();
      const id = plans()[0]!.runId;
      const a = start().dream;
      const b = start().dream;
      const target = `note:${sha8(OLD)}`;
      expect(a.fix(bot, id, target, false).ok).toBe(true);
      expect(b.fix(bot, id, target, false)).toEqual({ ok: false, error: "done" });
      const extra = "- Other edit after the OK 🌱\r\n";
      writeMemoryFile(bot, extra + memoryFileRaw(bot));
      expect(approve(true, id).ok).toBe(true);
      expect(Buffer.compare(Buffer.from(memoryFileRaw(bot)), Buffer.from(extra + raw))).toBe(0);
      expect(b.fix(bot, id, target, true)).toEqual({ ok: false, error: "undone" });
    });

    it("refuses an OK on an older plan and on a bot set to live", async () => {
      await quiet();
      const id = plans()[0]!.runId;
      setMode({ [bot]: "live" });
      expect(approve(false, id)).toEqual({ ok: false, error: "no-run" });
      setMode({ [bot]: "dry" });
      sleep.onSettled(bot);
      await quiet(SLEEP_GAP_MS);
      expect(plans()[0]!.runId).not.toBe(id);
      expect(approve(false, id)).toEqual({ ok: false, error: "not-newest" });
      expect(memoryFileRaw(bot)).toBe(raw);
    });

    it("never puts a fix back for an OK that arrives after its Undo", async () => {
      await quiet();
      const id = plans()[0]!.runId;
      expect(approve(false, id).ok).toBe(true);
      expect(approve(true, id).ok).toBe(true);
      vi.setSystemTime(Date.now() + 1000);
      expect(approve(false, id)).toEqual({ ok: false, error: "undone" });
      expect(memoryFileRaw(bot)).toBe(raw);
      expect(history().split(" (run ").length - 1).toBe(1);
    });

    it("keeps both lines when the fixed line was copied under another heading before Undo", async () => {
      await quiet();
      expect(approve(false).ok).toBe(true);
      const edited = memoryFileRaw(bot).replace(NEW, `${NEW}\r\n## Moved note\r\n${NEW}`);
      writeMemoryFile(bot, edited);
      expect(approve(true)).toEqual({ ok: false, error: "conflict" });
      expect(memoryFileRaw(bot)).toBe(edited);
    });

    it("leaves an identical line under another heading alone when the fixed line was edited by hand", async () => {
      writeMemoryFile(bot, `${raw}## Other project\r\n${NEW}\r\n`);
      await quiet();
      expect(approve(false).ok).toBe(true);
      const edited = memoryFileRaw(bot).replace(NEW, "- Hand edited after OK");
      writeMemoryFile(bot, edited);
      expect(approve(true)).toEqual({ ok: false, error: "conflict" });
      expect(memoryFileRaw(bot)).toBe(edited);
    });

    it("undoes the fixed line, not an identical line under another heading", async () => {
      writeMemoryFile(bot, `${raw}## Other project\r\n${NEW}\r\n`);
      await quiet();
      expect(approve(false).ok).toBe(true);
      expect(approve(true).ok).toBe(true);
      expect(memoryFileRaw(bot)).toBe(`${raw}## Other project\r\n${NEW}\r\n`);
    });

    it("refuses an OK once the note moved under a pinned heading and took a line under it", async () => {
      await quiet();
      const edited = raw.replace(OLD, `## Pinned decisions\r\n${OLD}\r\n  additional detail`);
      writeMemoryFile(bot, edited);
      expect(approve(false)).toEqual({ ok: false, error: "changed" });
      expect(memoryFileRaw(bot)).toBe(edited);
      const child = raw.replace(OLD, `${OLD}\r\n  additional detail`);
      writeMemoryFile(bot, child);
      expect(approve(false)).toEqual({ ok: false, error: "changed" });
      expect(memoryFileRaw(bot)).toBe(child);
    });

    it("saves the plan's record of a fix before MEMORY.md changes", async () => {
      await quiet();
      const atomic = await import("./atomic.ts");
      const original = atomic.writeFileAtomic;
      const seen: string[] = [];
      const spy = vi.spyOn(atomic, "writeFileAtomic").mockImplementation((path, ...rest) => {
        if (String(path).endsWith("plan.json")) seen.push(memoryFileRaw(bot));
        original(path, ...rest);
      });
      expect(approve(false).ok).toBe(true);
      expect(approve(true).ok).toBe(true);
      spy.mockRestore();
      expect(seen).toEqual([raw, raw.replace(OLD, NEW)]);
    });

    it("takes the archive back and keeps the OK when the plan cannot be saved", async () => {
      await quiet();
      const id = plans()[0]!.runId;
      const atomic = await import("./atomic.ts");
      const original = atomic.writeFileAtomic;
      const spy = vi.spyOn(atomic, "writeFileAtomic").mockImplementation((path, ...rest) => {
        if (String(path).endsWith("plan.json")) throw new Error("plan write failed");
        original(path, ...rest);
      });
      expect(() => approve(false, id)).toThrow("plan write failed");
      spy.mockRestore();
      expect(memoryFileRaw(bot)).toBe(raw);
      expect(history()).not.toContain(OLD);
      expect(plans()[0]!.fixes!.items[0]!.done).toBeUndefined();
      expect(approve(false, id).ok).toBe(true);
      expect(approve(true, id).ok).toBe(true);
      expect(memoryFileRaw(bot)).toBe(raw);
    });

    it("takes the plan and archive back when MEMORY.md cannot be saved", async () => {
      await quiet();
      const workspace = await import("./workspace.ts");
      const spy = vi.spyOn(workspace, "saveMemoryFile").mockImplementation(() => {
        throw new Error("memory write failed");
      });
      expect(() => approve(false)).toThrow("memory write failed");
      spy.mockRestore();
      expect(memoryFileRaw(bot)).toBe(raw);
      expect(history()).not.toContain(OLD);
      expect(plans()[0]!.fixes!.items[0]!.done).toBeUndefined();
      expect(approve(false).ok).toBe(true);
    });

    it("offers a newer correction in place of the waiting fix it supersedes", async () => {
      await quiet();
      expect(plans()[0]!.fixes!.items.find((item) => item.text === OLD)?.by).toBe(NEW);
      const update = NEW.replace("March", "April");
      typed.set("t1", [said("newer", Date.now() + 1000, "The main account plan ends in April now, not in March.")]);
      generator = flags([{ note: line(OLD), quote: "ends in April now", fix: update }]);
      sleep.onSettled(bot);
      await quiet(SLEEP_GAP_MS);
      const offered = plans()[0]!.fixes!.items.filter((item) => item.text === OLD);
      expect(offered.map((item) => [item.by, item.evidence.message])).toEqual([[update, "newer"]]);
    });

    it("drops a waiting fix once the owner takes it back and a newer pass finds nothing wrong", async () => {
      await quiet();
      expect(plans()[0]!.fixes!.items.find((item) => item.text === OLD)?.by).toBe(NEW);
      typed.set("t1", [said("retraction", Date.now() + 1000, "The main account plan ends in January after all, not March. January was right.")]);
      const sent: string[] = [];
      generator = async (prompt) => {
        if (prompt.includes("<pairs>")) sent.push(prompt);
        return JSON.stringify({ wrong: [] });
      };
      sleep.onSettled(bot);
      await quiet(SLEEP_GAP_MS);
      expect(sent.some((prompt) => prompt.includes("January was right") && prompt.includes(OLD))).toBe(true);
      expect(plans()[0]!.fixes!.items.find((item) => item.text === OLD)).toBeUndefined();
      expect(approve(false)).toEqual({ ok: false, error: "no-item" });
      expect(memoryFileRaw(bot)).toBe(raw);
    });

    it("drops a waiting fix when the owner takes back a newer correction in the same pass", async () => {
      await quiet();
      expect(plans()[0]!.fixes!.items.find((item) => item.text === OLD)?.by).toBe(NEW);
      const april = "The main account plan ends in April now, instead of March.";
      const withdraw = "The main account plan ends in January after all, please disregard April and March.";
      typed.set("t1", [said("april", Date.now() + 90_000, april), said("withdraw", Date.now() + 180_000, withdraw)]);
      const judged: string[] = [];
      generator = async (prompt) => {
        const pairs = [...prompt.matchAll(/^PAIR\n(L\d+) \(written [^)]*\): ([^\n]+)\n(M\d+) \([^)]*\): ([^\n]+)/gm)];
        const wrong = pairs.flatMap(([, note, text, message, row]) => {
          if (text !== OLD) return [];
          judged.push(row!);
          return row === april ? [{ note, message, quote: "ends in April now", fix: NEW.replace("March", "April") }] : [];
        });
        return JSON.stringify({ wrong });
      };
      sleep.onSettled(bot);
      await quiet(SLEEP_GAP_MS);
      // only the newest message is judged: nothing after it needs reading
      expect(judged).toEqual([withdraw]);
      expect(plans()[0]!.fixes!.items.find((item) => item.text === OLD)).toBeUndefined();
      expect(approve(false)).toEqual({ ok: false, error: "no-item" });
      expect(memoryFileRaw(bot)).toBe(raw);
    });

    it.each([
      ["after a newer correction in the same pass", true, "Please disregard March and April. The main account's plan ends in January."],
      ["with no newer correction", false, "Please disregard March and April. The main account's plan ends in January."],
      ["in a line no guard holds back", true, "Disregard March and April, the main account's plan ends in January for now"],
    ])("drops a waiting fix when the owner restates the saved note %s", async (_, newer, withdraw) => {
      await quiet();
      expect(plans()[0]!.fixes!.items.find((item) => item.text === OLD)?.by).toBe(NEW);
      const april = "The main account plan ends in April now, instead of March.";
      typed.set("t1", [...(newer ? [said("april", Date.now() + 90_000, april)] : []), said("withdraw", Date.now() + 180_000, withdraw)]);
      generator = async (prompt) => {
        const pairs = [...prompt.matchAll(/^PAIR\n(L\d+) \(written [^)]*\): ([^\n]+)\n(M\d+) \([^)]*\): ([^\n]+)/gm)];
        return JSON.stringify({ wrong: pairs.flatMap(([, note, text, message, row]) => (text === OLD && row === april ? [{ note, message, quote: "ends in April now", fix: NEW.replace("March", "April") }] : [])) });
      };
      sleep.onSettled(bot);
      await quiet(SLEEP_GAP_MS);
      expect(plans()[0]!.fixes!.items.find((item) => item.text === OLD)).toBeUndefined();
      expect(approve(false)).toEqual({ ok: false, error: "no-item" });
      expect(memoryFileRaw(bot)).toBe(raw);
    });

    it.each([
      ["across two sentences after a newer correction", true, "- The main account's plan is billed monthly. It ends in January (noted 2026-11-20)", "Please disregard March and April. The main account's plan is billed monthly. It ends in January."],
      ["across two sentences", false, "- The main account's plan is billed monthly. It ends in January (noted 2026-11-20)", "The main account's plan is billed monthly. It ends in January"],
      ["with an abbreviation", false, "- The main U.S. account's plan ends in January (noted 2026-11-20)", "The main U.S. account's plan ends in January"],
      ["with a version number", false, "- The main account on version 2.1 ends in January (noted 2026-11-20)", "The main account on version 2.1 ends in January"],
      ["with a price", false, "- The main account costs 9.50 a month through January (noted 2026-11-20)", "The main account costs 9.50 a month through January"],
    ])("drops a waiting fix when the owner restates a saved note %s", async (_, newer, note, withdraw) => {
      const text = raw.replace(OLD, note);
      const march = note.replace("January", "March");
      writeMemoryFile(bot, text);
      generator = flags([{ note: line(OLD), quote: "It lasts till march", fix: march }]);
      await quiet();
      expect(plans()[0]!.fixes!.items.find((item) => item.text === note)?.by).toBe(march);
      const april = "The main account plan ends in April now, instead of March.";
      typed.set("t1", [...(newer ? [said("april", Date.now() + 90_000, april)] : []), said("withdraw", Date.now() + 180_000, withdraw)]);
      generator = async (prompt) => {
        const pairs = [...prompt.matchAll(/^PAIR\n(L\d+) \(written [^)]*\): ([^\n]+)\n(M\d+) \([^)]*\): ([^\n]+)/gm)];
        return JSON.stringify({ wrong: pairs.flatMap(([, ref, old, message, row]) => (old === note && row === april ? [{ note: ref, message, quote: "ends in April now", fix: note.replace("January", "April") }] : [])) });
      };
      sleep.onSettled(bot);
      await quiet(SLEEP_GAP_MS);
      expect(plans()[0]!.fixes!.items.find((item) => item.text === note)).toBeUndefined();
      expect(start().dream.fix(bot, plans()[0]!.runId, `note:${sha8(note)}`, false)).toEqual({ ok: false, error: "no-item" });
      expect(memoryFileRaw(bot)).toBe(text);
      expect(history()).toBe("");
    });

    const TWO = "- The main account's plan is billed monthly. It ends in January (noted 2026-11-20)";
    // every withdrawal, restatement, punctuation, quote and "not X" wording the reviews found
    const WITHDRAWALS: [string, string][] = [
      [OLD, "The main account plan ends in January after all, not March. January was right."],
      [OLD, "The main account plan ends in January after all, please disregard April and March."],
      [OLD, "Please disregard March and April. The main account's plan ends in January."],
      [OLD, "Disregard March and April, the main account's plan ends in January for now"],
      [OLD, "The main account's plan ends in January, not March or April."],
      [OLD, "The main account's plan ends in January, not March"],
      [OLD, "Please disregard March and April. 'The main account's plan ends in January.'"],
      [OLD, "'The main account's plan ends in January.'"],
      [OLD, "“The main account's plan ends in January.” Not March, not April."],
      [OLD, "Please disregard March and April."],
      [OLD, "Not March or April, it's January."],
      [TWO, "Please disregard March and April. The main account's plan is billed monthly. It ends in January."],
      [TWO, "March and April are both wrong. The main account's plan is billed monthly. It ends in January."],
      [TWO, "March and April are both wrong: The main account's plan is billed monthly. It ends in January."],
      [TWO, "The main account's plan is billed monthly. It ends in January, not March or April."],
      ["- The main U.S. account's plan ends in January (noted 2026-11-20)", "The main U.S. account's plan ends in January, not March or April."],
      ["- The main account on version 2.1 ends in January (noted 2026-11-20)", "The main account on version 2.1 ends in January"],
      ["- The main account costs 9.50 a month through January (noted 2026-11-20)", "The main account costs 9.50 a month through January, not March."],
      [TWO, "The main account's plan is billed monthly. It ends in January"],
      [TWO, "March is wrong: The main account's plan is billed monthly. It ends in January."],
      [TWO, "Please disregard March and April. Keep the original: 'The main account's plan is billed monthly. It ends in January'."],
      [TWO, 'Please disregard March and April. Keep the original: "The main account\'s plan is billed monthly. It ends in January".'],
      [OLD, "No, disregard March and April, The main account's plan ends in January."],
      [OLD, "Please disregard March and April, The main account's plan ends in January."],
      ["- The main U.S. account's plan ends in January (noted 2026-11-20)", "The main U.S. account's plan ends in January"],
      ["- The main U.S. account on version 2.1 costs 9.50 a month through January (noted 2026-11-20)", "Please disregard March and April. The main U.S. account on version 2.1 costs 9.50 a month through January."],
      ["- The main U.S. account on version 2.1 costs 9.50 a month through January (noted 2026-11-20)", "Please disregard March and April.\r\nThe main U.S. account on version 2.1 costs 9.50 a month through January."],
    ];
    const PLAN_DOTTED = "- The main U.S. account on version 2.1 costs 9.50 a month through January (noted 2026-11-20)";
    // the later reviews' wordings: abbreviations, paragraphs past what a judge reads, a message past six lines
    WITHDRAWALS.push(
      [OLD, "Jan. is correct. Ignore Mar. and Apr."],
      [OLD, "January is correct. Ignore March and April."],
      [OLD, "No, Jan. Ignore Mar. and Apr."],
      [OLD, "No, Jan. Ignore Mar."],
      [OLD, "No, January. Ignore March and April."],
      [OLD, "The main account's plan ends in January."],
      [OLD, "Jan. is correct. Ignore Apr."],
      [OLD, "January is correct. Ignore April."],
      [TWO, "Strike March / April! (The main account's plan is billed monthly. It ends in January.)"],
      [PLAN_DOTTED, "Billing confirmed: The main U.S. account on version 2.1 costs 9.50 a month through January. Ignore March and April."],
      [OLD, "Please disregard March and April. The main account's plan ends in January. I checked the renewal paperwork against the signed invoice from the vendor. The first email was a draft. I had already copied its date into our team calendar before billing sent us the signed copy. The dates for the other subscriptions are fine. I compared the signed copy with the previous renewal and asked billing to look."],
      [OLD, "Please disregard March and April. The main account's plan ends in January. I checked the renewal paperwork against the signed invoice from the vendor. The first email was a draft. I had already copied its date into our team calendar before billing sent us the signed copy. The dates for the other subscriptions are fine. I compared the signed copy with the previous renewal and asked billing to look ."],
      [OLD, "Please disregard March and April. The main account's plan ends in January. I checked the renewal paperwork against the signed invoice from the vendor. The first email was a draft. I had already copied its date into our team calendar before billing sent us the signed copy. The dates for the other subscriptions are fine. I compared the signed copy with the previous renewal and asked billing to look again. Please use the signed version when preparing the handover for next week."],
      [OLD, "Please disregard March and April. The main account's plan ends in January.\nBilling update for the team:\nInvoice checked.\nCalendar checked.\nContract checked.\nNo further changes.\nThanks."],
      [OLD, "Disregard March and April. The main account's plan ends in January. I checked the renewal paperwork against the invoice from the vendor. The first email was a draft and I had copied the date into our team calendar before the person who manages billing sent the signed copy. The dates on the other subscriptions are fine. I cross-checked the signed copy against last year's renewal and asked billing ."],
      [OLD, "Disregard March and April. The main account's plan ends in January. I checked the renewal paperwork against the invoice from the vendor. The first email was a draft and I had copied the date into our team calendar before the person who manages billing sent the signed copy. The dates on the other subscriptions are fine. I cross-checked the signed copy against last year's renewal and asked billing t."],
      [OLD, "Disregard March and April. The main account's plan ends in January. I checked the renewal paperwork against the invoice from the vendor. The first email was a draft and I had copied the date into our team calendar before the person who manages billing sent the signed copy. The dates on the other subscriptions are fine. I cross-checked the signed copy against last year's renewal and asked billing to look again. Please use the signed version when preparing the handover for next week."],
      [PLAN_DOTTED, "March and April are wrong. The main U.S. account on version 2.1 costs 9.50 a month through January. I checked the renewal paperwork against the invoice from the vendor. The first email was a draft and I had copied the date into our team calendar before the person who manages billing sent the signed copy. The dates on the other subscriptions are fine. I cross-checked the signed copy against last year's renewal and asked billing to look again. Please use the signed version when preparing the handover for next week."],
      [OLD, "The main account plan stays in January. The password is SampleFixtureOnly42!"],
    );
    // judges that read every earlier line about the note as a fix to the last month it names; the withdrawal itself they read as written
    const eager = (note: string, withdraw: string): NoteGenerator => async (prompt) => JSON.stringify({
      wrong: [...prompt.matchAll(/^PAIR\n(L\d+) \(written [^)]*\): ([^\n]+)\n(M\d+) \([^)]*\): ([^\n]+)/gm)].flatMap(([, ref, old, message, row]) => {
        const month = /april/i.test(row!) ? "April" : /march/i.test(row!) ? "March" : null;
        return old === note && month && !withdraw.startsWith(row!) ? [{ note: ref, message, quote: row!.trim(), fix: note.replace("January", month) }] : [];
      }),
    });
    it.each(WITHDRAWALS.flatMap(([note, withdraw]) => (["waiting", "OK before the next pass", "waiting, then April", "same pass", "same pass after April"] as const).map((when) => [when, withdraw, note] as const)))("writes no withdrawn value, %s: %s", async (when, withdraw, note) => {
      const text = raw.replace(OLD, note);
      writeMemoryFile(bot, text);
      mkdirSync(join(dreamedPath(bot), ".."), { recursive: true });
      const archive = "# Dreamed\n\n## 2026-11-01 (run 0badc0de)\n- An older moved note\n";
      writeFileSync(dreamedPath(bot), archive);
      const april = "The main account plan ends in April now, instead of March.";
      const lines = [said("m1", NOW - DAY, "For the main account plan leave it. It lasts till march and thats my main account anyways.")];
      if (when === "same pass after April") lines.push(said("april", NOW - DAY + 60_000, april));
      if (when.startsWith("same pass")) lines.push(said("withdraw", NOW - DAY + 120_000, withdraw));
      typed.set("t1", lines);
      generator = eager(note, withdraw);
      await quiet();
      if (!when.startsWith("same pass")) {
        expect(plans()[0]!.fixes!.items.find((item) => item.text === note)?.by).toBe(note.replace("January", "March"));
        typed.set("t1", [...lines, ...(when === "waiting, then April" ? [said("april", Date.now() + 90_000, april)] : []), said("withdraw", Date.now() + 180_000, withdraw)]);
        if (when !== "OK before the next pass") {
          sleep.onSettled(bot);
          await quiet(SLEEP_GAP_MS);
        }
      }
      for (const plan of plans()) for (const item of plan.fixes?.items ?? []) start().dream.fix(bot, plan.runId, item.target, false);
      expect(memoryFileRaw(bot)).toBe(text);
      expect(readFileSync(dreamedPath(bot), "utf8")).toBe(archive);
    });

    it.each([
      ["past what a judge reads", "The main account plan ends in April now.\n\nI looked at the renewal spreadsheet while preparing the handover this morning. It was the version we circulated before the vendor sent back the signed paperwork. I have also asked billing to annotate the row so that the next person can tell where it came from.\n\nOne more detail before you send the renewal summary to the team. Our reminders are already in the shared calendar, and the invoice number matches the order we placed. I will include both documents in the handover so anyone reviewing the dates has all the background.\n\nI checked the signed copy. Disregard April and keep the saved date.", false],
      ["in a short message", "The main account plan ends in April now. I checked the signed copy. Disregard April and keep the saved date.", true],
      ["in one rejecting line", "It would be wrong to say the main account plan ends in April now. Keep the date we have.", true],
    ])("gives the judges every word of a message that takes its own value back %s, or none of it", async (_, owner, whole) => {
      typed.set("t1", [said("self", NOW - DAY, owner)]);
      const read: string[] = [];
      generator = async (prompt) => {
        if (prompt.includes("<pairs>")) read.push(prompt);
        return JSON.stringify({ wrong: [] });
      };
      await quiet();
      expect(read.length > 0).toBe(whole);
      expect(read.every((prompt) => prompt.includes(owner))).toBe(true);
      expect(plans()[0]!.fixes!.items).toEqual([]);
    });

    it("refuses an OK once the owner wrote anything since, and keeps the item out of date", async () => {
      await quiet();
      typed.get("t1")!.push(said("later", Date.now() + 1000, "The weekly sync moved to Thursday afternoons."));
      expect(approve(false)).toEqual({ ok: false, error: "outdated" });
      expect(memoryFileRaw(bot)).toBe(raw);
      expect(history()).toBe("");
      expect(start().dream.latest(bot)!.dream.fixes!.items.find((item) => item.text === OLD)!.outdated).toBe(Date.now());
      typed.get("t1")!.pop();
      expect(approve(false)).toEqual({ ok: false, error: "outdated" });
      expect(memoryFileRaw(bot)).toBe(raw);
    });

    it.each([
      ["a line cut whole as sensitive", said("later", NOW + SLEEP_IDLE_MS + 1000, "The main account password is SunnyHarbor! now")],
      ["a paragraph no judge reads", said("later", NOW + SLEEP_IDLE_MS + 1000, "Please disregard March and April. The main account's plan ends in January. I checked the renewal paperwork against the signed invoice from the vendor. The first email was a draft. I had already copied its date into our team calendar before billing sent us the signed copy. The dates for the other subscriptions are fine. I compared the signed copy with the previous renewal and asked billing to look again. Please use the signed version when preparing the handover for next week.")],
      ["a picture with no words", { ...said("later", NOW + SLEEP_IDLE_MS + 1000, '<attached-image path="a.png" />'), hasImage: true }],
      ["a message in another chat", said("t2:later", NOW + SLEEP_IDLE_MS + 1000, "ok")],
      ["its own line edited", said("m1", NOW - DAY, "For the main account plan leave it. It lasts till march or January.")],
    ])("refuses an OK after %s", async (_, change) => {
      await quiet();
      const thread = change.id.startsWith("t2:") ? "t2" : "t1";
      const rows = (typed.get(thread) ?? []).filter((each) => each.id !== change.id);
      typed.set(thread, [...rows, change].sort((a, b) => a.at - b.at));
      expect(approve(false)).toEqual({ ok: false, error: "outdated" });
      expect(memoryFileRaw(bot)).toBe(raw);
    });

    // a reply synced from another PC: its stamp can sit after, on or before the message it answers
    const SYNCED = [
      "Disregard March and keep the saved date.",
      `Please disregard March and April. The main account's plan ends in January.${" The invoice was checked.".repeat(20)}`,
      "Jan. is correct. Ignore Mar. and Apr.",
      "The main account's plan ends in January",
      "U.S. billing, rev. 2.1: both March and April were estimates. The main account's plan ends in January.",
      "The main account's plan ends in January, not March or April.",
    ];
    it.each(SYNCED.flatMap((text) => [1, 0, -1500, -DAY].flatMap((delta) => (["tap", "refresh", "first pass"] as const).flatMap((when) => [true, false].map((linked) => [when, delta, linked, text] as const)))))("writes no withdrawn value from a synced reply, %s, %i ms, linked %s: %s", async (when, delta, linked, text) => {
      const reply = said("reply", NOW - DAY + delta, text);
      if (linked) reply.parentId = "m1";
      if (when === "first pass") typed.set("t1", [...typed.get("t1")!, reply]);
      await quiet();
      if (when !== "first pass") {
        expect(plans()[0]!.fixes!.items.find((item) => item.text === OLD)?.by).toBe(NEW);
        typed.set("t1", [...typed.get("t1")!, reply]);
        if (when === "refresh") {
          sleep.onSettled(bot);
          await quiet(SLEEP_GAP_MS);
        }
      }
      for (const plan of plans()) for (const item of plan.fixes?.items ?? []) start().dream.fix(bot, plan.runId, item.target, false);
      expect(memoryFileRaw(bot)).toBe(raw);
      expect(history()).toBe("");
    });

    it("writes no value once a synced reply stamped before a newer correction restates the saved note", async () => {
      await quiet();
      const april = said("april", Date.now() + 1000, "The main account plan ends in April now, instead of March.");
      typed.set("t1", [...typed.get("t1")!, april]);
      generator = flags([{ note: line(OLD), quote: "ends in April now", fix: NEW.replace("March", "April") }]);
      sleep.onSettled(bot);
      await quiet(SLEEP_GAP_MS);
      expect(plans()[0]!.fixes!.items.find((item) => item.text === OLD)?.evidence.message).toBe("april");
      typed.set("t1", [...typed.get("t1")!, { ...said("restated", april.at - 1500, "The main account's plan ends in January, not March or April."), parentId: "april" }]);
      sleep.onSettled(bot);
      await quiet(SLEEP_GAP_MS);
      for (const plan of plans()) for (const item of plan.fixes?.items ?? []) start().dream.fix(bot, plan.runId, item.target, false);
      expect(memoryFileRaw(bot)).toBe(raw);
      expect(history()).toBe("");
    });

    // the withdrawal reached a chat first; April, sent before it after the turn or drained after it, landed last; across chats no order holds
    it.each([
      ["a held send in the same chat", "t1", 500, 2, false],
      ["holds drained in reverse across chats", "t2", 500, 2, false],
      ["a send count no newer than the withdrawal's", "t2", 1500, 3, false],
      ["every order agreeing across chats", "t2", 1500, 4, false],
      ["every order agreeing in the same chat", "t1", 1500, 4, true],
    ] as const)("writes no value from %s that landed after a newer withdrawal", async (_, chat, acted, seq, listed) => {
      await quiet();
      const sent = Date.now();
      const withdraw = { ...said("withdraw", sent + 1000, "Disregard April and keep the saved date."), actedAt: sent + 1000, sendSeq: 3 };
      const april = { ...said("april", sent + 2000, "The main account plan ends in April now."), actedAt: sent + acted, sendSeq: seq, waited: true };
      places.set(withdraw, ++place);
      places.set(april, ++place);
      typed.set("t1", [...typed.get("t1")!, ...(chat === "t1" ? [withdraw] : []), april]);
      if (chat === "t2") typed.set("t2", [withdraw]);
      generator = flags([{ note: line(OLD), quote: "plan ends in April now", fix: OLD.replace("January", "April") }]);
      sleep.onSettled(bot);
      await quiet(SLEEP_GAP_MS);
      expect(plans()[0]!.fixes!.items.find((item) => item.text === OLD)?.evidence.message).toBe(listed ? "april" : undefined);
      if (listed) return;
      for (const plan of plans()) for (const item of plan.fixes?.items ?? []) start().dream.fix(bot, plan.runId, item.target, false);
      expect(memoryFileRaw(bot)).toBe(raw);
      expect(history()).toBe("");
    });

    it("refuses an OK while an owner send waits to reach the chat, and keeps the item out of date", async () => {
      await quiet();
      waiting = true;
      expect(approve(false)).toEqual({ ok: false, error: "outdated" });
      expect(memoryFileRaw(bot)).toBe(raw);
      expect(history()).toBe("");
      waiting = false;
      expect(approve(false)).toEqual({ ok: false, error: "outdated" });
      expect(memoryFileRaw(bot)).toBe(raw);
    });

    it("judges nothing and drops a waiting fix while an owner send waits", async () => {
      waiting = true;
      await quiet();
      expect(generate.mock.calls.some(([prompt]) => prompt.includes("<pairs>"))).toBe(false);
      expect(plans()[0]!.fixes!.items).toEqual([]);
      waiting = false;
      typed.set("t1", [said("m2", Date.now() + 1000, M1)]);
      sleep.onSettled(bot);
      await quiet(SLEEP_GAP_MS);
      expect(plans()[0]!.fixes!.items.find((item) => item.text === OLD)?.by).toBe(NEW);
      waiting = true;
      sleep.onSettled(bot);
      await quiet(SLEEP_GAP_MS);
      expect(plans()[0]!.fixes!.items.find((item) => item.text === OLD)).toBeUndefined();
    });

    it("lists nothing the judges found once the owner wrote while they read", async () => {
      const judged = generator;
      generator = async (prompt, ...rest) => {
        if (prompt.includes("<pairs>")) typed.set("t1", [...typed.get("t1")!, said("during", NOW - DAY - 1, "ok")]);
        return judged(prompt, ...rest);
      };
      await quiet();
      expect(plans()[0]!.fixes!.items).toEqual([]);
      expect(memoryFileRaw(bot)).toBe(raw);
    });

    it("takes an OK while the owner wrote nothing since, a bot's own reply after it", async () => {
      await quiet();
      // SAFETY: the check reads only id, at, role, kind and text of a row.
      typed.get("t1")!.push({ id: "reply", at: Date.now() + 1000, role: "bot", kind: "text", text: "Noted." } as Message);
      expect(approve(false).ok).toBe(true);
      expect(memoryFileRaw(bot)).toBe(raw.replace(OLD, NEW));
    });

    it("drops a waiting fix once the owner writes anything after it, and judges the newest line fresh", async () => {
      await quiet();
      typed.set("t1", [said("other", Date.now() + 1000, "The weekly sync moved to Thursday afternoons.")]);
      generator = async () => JSON.stringify({ wrong: [] });
      sleep.onSettled(bot);
      await quiet(SLEEP_GAP_MS);
      expect(plans()[0]!.fixes!.items.find((item) => item.text === OLD)).toBeUndefined();
      expect(approve(false)).toEqual({ ok: false, error: "no-item" });
      expect(memoryFileRaw(bot)).toBe(raw);
    });

    it("offers the newest of two agreed corrections in one pass", async () => {
      const march = "The main account plan ends in March, not in January";
      const april = "The main account plan ends in April now, not in March";
      typed.set("t1", [said("march", NOW - DAY, march), said("april", NOW - DAY + 3_600_000, april)]);
      const update = NEW.replace("March", "April");
      // March first in the reply, so order alone does not pick April
      generator = async (prompt) => {
        const pairs = [...prompt.matchAll(/^PAIR\n(L\d+) \(written [^)]*\): ([^\n]+)\n(M\d+) \([^)]*\): ([^\n]+)/gm)];
        const wrong = pairs.flatMap(([, note, text, message, row]) => (text === OLD && (row === march || row === april) ? [{ note, message, row, quote: row === march ? "ends in March" : "ends in April now", fix: row === march ? NEW : update }] : []));
        wrong.sort((a, b) => Number(b.row === march) - Number(a.row === march));
        return JSON.stringify({ wrong });
      };
      await quiet();
      const offered = plans()[0]!.fixes!.items.filter((item) => item.text === OLD);
      expect(offered.map((item) => [item.by, item.evidence.message])).toEqual([[update, "april"]]);
    });

    it("does no wrong-note work when a turn settles, only once the bot is idle", async () => {
      const count = () => generate.mock.calls.filter(([prompt]) => prompt.includes("<pairs>")).length;
      sleep.onSettled(bot);
      const atSettlement = count();
      await quiet(SLEEP_IDLE_MS - 1);
      const beforeIdle = count();
      await quiet(1);
      expect([atSettlement, beforeIdle, count()]).toEqual([0, 0, 1]);
    });

    it("changes exactly one line when one of two fixes gets its OK", async () => {
      const second = "- The app uses a blue theme (noted 2026-11-20)";
      const two = `${raw}${second}\r\n`;
      writeMemoryFile(bot, two);
      typed.set("t1", [said("m1", NOW - DAY, `${M1}. For the app theme use green from now on.`)]);
      generator = flags([
        { note: line(OLD), quote: "It lasts till march", fix: NEW },
        { note: `L${two.split("\r\n").indexOf(second) + 1}`, quote: "use green from now on", fix: second.replace("blue", "green") },
      ]);
      await quiet();
      expect(plans()[0]!.fixes!.items.filter((item) => !item.listOnly).map((item) => item.text).sort()).toEqual([OLD, second].sort());
      expect(approve(false).ok).toBe(true);
      expect(memoryFileRaw(bot)).toBe(two.replace(OLD, NEW));
      expect(plans()[0]!.fixes!.items.find((item) => item.text === second)?.done).toBeUndefined();
    });

    it("checks no owner line for a bot set to live", async () => {
      setMode({ [bot]: "live" });
      await quiet();
      expect(generate.mock.calls.some(([prompt]) => prompt.includes("<pairs>"))).toBe(false);
      expect(plans()).toEqual([]);
    });
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
    setMode({ [bot]: "live" });
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

  it("refreshes recall whenever Sleep changes a bot's memory, so the next question finds a moved line", () => {
    const sleepCall = index.slice(index.indexOf("const memorySleep = createMemorySleep({"), index.indexOf("const projectNotesCheck = "));
    expect(sleepCall).toMatch(/changed: \(botId\) => \{\s*broadcast\(\{ kind: "memory\.changed", botId \}\);\s*void memoryLookup\.refresh\(botId, true\);/);
  });

  it("reads every owner row the store holds and the waiting sends, so no later word goes unread", () => {
    expect(call).toContain("stored: (threadId) => userMarks(threadId)");
    expect(call).toContain("under: (threadId, id) => rowsUnder(threadId, id)");
    expect(call).toContain("waiting: (botId) => hasQueuedSends(botId)");
  });

  it("writes no packet in dry mode", () => {
    const source = readFileSync(join(import.meta.dirname, "dream-live.ts"), "utf8");
    expect(source).not.toMatch(/persistTaskPacket|writeTaskPacket|writeTaskResumePacket|stageTaskResumePacket/);
  });
});
