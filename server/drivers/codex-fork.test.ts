import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { ProviderInstance, RuntimeEvent, SideEvent } from "../contracts.ts";
import * as procs from "../procs.ts";
import { quickAsk, sideIdle } from "../side-chat.ts";
import { observeLive } from "../side-live-state.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { CodexDriver } from "./codex.ts";
import { forkCodex } from "./codex-fork.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-codex-app-server.ts");
const LEDGER = join(DATA_DIR, "side-chat", "live.json");
const envKeys = ["FAKE_CODEX_MODE", "FAKE_CODEX_DUMP", "FAKE_CODEX_CONFIG", "FAKE_CODEX_TOOL_FIXTURE", "FAKE_CODEX_MESSAGES"];
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

let scratch: string;
let instance: ProviderInstance | undefined;
let recorder: EventRecorder | undefined;

beforeEach(() => {
  chmodSync(FAKE_CLI, 0o755);
  scratch = mkdtempSync(join(tmpdir(), "omb-codex-fork-"));
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  recorder?.stop();
  await instance?.dispose();
  instance = undefined;
  await sideIdle();
  for (const key of envKeys) delete process.env[key];
  await removeTempDir(scratch);
});

const calls = (dump: string): Array<{ method: string; params: any }> => JSON.parse(readFileSync(dump, "utf8")).calls;

async function mainThread(mode: string, threadId: string) {
  process.env.FAKE_CODEX_MODE = mode;
  instance = await CodexDriver.create({ instanceId: "codex-side", displayName: "Codex", environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
  recorder = recordEvents(instance.adapter);
  await instance.adapter.sendTurn({ threadId, text: "main work", cwd: scratch });
  await recorder.until((event) => event.type === "session.started");
  return instance;
}

describe("Codex fork through quickAsk (fake app-server)", () => {
  it("forks the saved thread read-only and ephemeral, takes the turn on the fork id, leaves no child", async () => {
    const dump = join(scratch, "dump.json");
    const side = await mainThread("bench-quiet", "t-fork");
    await recorder!.until((event) => event.type === "turn.completed");
    process.env.FAKE_CODEX_DUMP = dump;
    const spawn = vi.spyOn(procs, "spawnCli");
    const result = await quickAsk({ instance: side, messages: [] }, "t-fork", { text: "what port?" });
    expect(result).toMatchObject({ route: "answer", text: "done from fake codex" });
    await sideIdle();

    const sent = calls(dump);
    expect(sent.find((call) => call.method === "thread/fork")?.params).toEqual({
      threadId: "codex-thread-1",
      ephemeral: true,
      excludeTurns: true,
      sandbox: "read-only",
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      config: { web_search: "disabled" },
    });
    const turn = sent.find((call) => call.method === "turn/start")!.params;
    expect(turn.threadId).toBe("codex-fork-1");
    expect(turn.input[0].text).toMatch(/^\[Quick helper\.[\s\S]*\n\nwhat port\?$/);
    expect(sent.map((call) => call.method).filter((method) => method === "thread/start" || method === "thread/resume")).toEqual([]);

    const child = spawn.mock.results.at(-1)!.value;
    expect(child.spawnargs.join(" ")).toContain("app-server");
    expect(alive(child.pid)).toBe(false);
    expect(existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8")) : []).toEqual([]);
  });

  it("starts the side app-server with web search off and every MCP server disabled", async () => {
    const dump = join(scratch, "dump.json");
    const side = await mainThread("bench-quiet", "t-mcp");
    await recorder!.until((event) => event.type === "turn.completed");
    process.env.FAKE_CODEX_DUMP = dump;
    process.env.FAKE_CODEX_CONFIG = JSON.stringify({ mcp_servers: { agents: { command: "never-run" }, github: { command: "never-run" } } });
    await quickAsk({ instance: side, messages: [] }, "t-mcp", { text: "what port?" });
    await sideIdle();

    const { argv } = JSON.parse(readFileSync(dump, "utf8"));
    expect(argv).toContain('web_search="disabled"');
    expect(argv).not.toContain('web_search="live"');
    expect(argv.join(" ")).not.toContain("mcp_servers.");
    const sent = calls(dump);
    expect(sent.find((call) => call.method === "config/read")?.params).toEqual({ cwd: scratch });
    expect(sent.find((call) => call.method === "thread/fork")?.params.config).toEqual({
      web_search: "disabled",
      "mcp_servers.agents.enabled": false,
      "mcp_servers.github.enabled": false,
    });
  });

  it("hands off on a non-read tool item", async () => {
    const side = await mainThread("happy", "t-tool");
    await recorder!.until((event) => event.type === "turn.completed");
    expect(await quickAsk({ instance: side, messages: [] }, "t-tool", { text: "save it" })).toMatchObject({ route: "handoff" });
  });

  it("hands off when an approval is requested", async () => {
    const fixture = join(scratch, "no-frames.json");
    writeFileSync(fixture, "[]");
    process.env.FAKE_CODEX_TOOL_FIXTURE = fixture;
    const side = await mainThread("approval", "t-ask");
    expect(await quickAsk({ instance: side, messages: [] }, "t-ask", { text: "delete it" })).toMatchObject({ route: "handoff" });
  });

  it("hands off at the 12 s cap and leaves no child", async () => {
    const side = await mainThread("steer", "t-cap");
    const spawn = vi.spyOn(procs, "spawnCli");
    const fork = vi.spyOn(side, "fork");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled = false;
    const pending = quickAsk({ instance: side, messages: [] }, "t-cap", { text: "slow?" }).then((result) => {
      settled = true;
      return result;
    });
    const streamed = new Promise<void>((resolve) => {
      fork.mock.results[0]!.value.onEvent((event: SideEvent) => event.type === "text" && resolve());
    });
    await streamed;
    await vi.advanceTimersByTimeAsync(11_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ route: "handoff" });
    await sideIdle();
    expect(alive(spawn.mock.results.at(-1)!.value.pid)).toBe(false);
    expect(existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8")) : []).toEqual([]);
  });

  it("gives no fork before the thread ever spawned", async () => {
    const side = await mainThread("bench-quiet", "t-known");
    expect(side.fork!({ threadId: "t-never", text: "hi" })).toBeNull();
  });
});

describe("Codex fork gets the same live state and guard as Claude's", () => {
  const at = () => new Date().toISOString();
  const ev = (threadId: string, id: string, rest: Record<string, unknown>) => observeLive({ eventId: id, provider: "codex", threadId, createdAt: at(), ...rest } as RuntimeEvent);

  async function forkTurn(threadId: string, frames: object[], answer: string) {
    const dump = join(scratch, `${threadId}.json`);
    const fixture = join(scratch, `${threadId}-frames.json`);
    writeFileSync(fixture, JSON.stringify(frames));
    process.env.FAKE_CODEX_TOOL_FIXTURE = fixture;
    process.env.FAKE_CODEX_MESSAGES = JSON.stringify([{ text: answer }]);
    process.env.FAKE_CODEX_DUMP = dump;
    const result = await quickAsk({ instance: instance!, messages: [] }, threadId, { text: "what port?" });
    await sideIdle();
    return { result, sent: calls(dump).find((call) => call.method === "turn/start")!.params.input[0].text as string };
  }

  it("sends the live block ahead of the ask", async () => {
    await mainThread("bench-quiet", "t-live");
    await recorder!.until((event) => event.type === "turn.completed");
    ev("t-live", "l1", { type: "turn.started" });
    ev("t-live", "l2", { type: "item.started", itemType: "tool", itemId: "a1", title: "ask_bot", summary: "mina" });
    const { sent } = await forkTurn("t-live", [], "HANDOFF");
    expect(sent).toMatch(/^\[Main task right now, as of [\d:]+, from Wink:\n- Open now, still running, no result yet: ask_bot mina[\s\S]*\]\n\n\[Quick helper\.[\s\S]*what port\?$/);
  });

  it("attaches a small changed file and counts it as read", async () => {
    await mainThread("bench-quiet", "t-attach");
    await recorder!.until((event) => event.type === "turn.completed");
    const notes = join(scratch, "notes.md");
    writeFileSync(notes, "Release: Tue Nov 24");
    ev("t-attach", "a1", { type: "turn.started" });
    ev("t-attach", "a2", { type: "item.started", itemType: "tool", itemId: "f1", title: "edit", verb: "Edit" });
    ev("t-attach", "a3", { type: "item.completed", itemType: "tool", itemId: "f1", ok: true, writes: [notes] });
    const { result, sent } = await forkTurn("t-attach", [], "notes.md says Tue Nov 24.");
    expect(sent).toContain(`--- ${notes} ---\nRelease: Tue Nov 24`);
    expect(result).toMatchObject({ route: "answer", text: "notes.md says Tue Nov 24." });
  });

  it("flags a file a fileChange is still writing and hands off an answer naming it", async () => {
    const notes = join(scratch, "notes.md");
    const fixture = join(scratch, "main-frames.json");
    writeFileSync(fixture, JSON.stringify([{ method: "item/started", params: { item: { id: "f1", type: "fileChange", status: "inProgress", changes: [{ path: notes, kind: { type: "update" }, diff: "" }] } } }]));
    process.env.FAKE_CODEX_TOOL_FIXTURE = fixture;
    await mainThread("bench-quiet", "t-open");
    await recorder!.until((event) => event.type === "turn.completed");
    for (const event of recorder!.events) if (event.type !== "turn.completed") observeLive(event);
    const { result, sent } = await forkTurn("t-open", [], "notes.md says Friday.");
    expect(sent).toContain(`- Being written now, don't state what it says: ${notes}`);
    expect(result).toMatchObject({ route: "handoff" });
  });

  it("counts a shell read or search hit as a lookup for the unseen-file guard", async () => {
    await mainThread("bench-quiet", "t-guard");
    await recorder!.until((event) => event.type === "turn.completed");
    const config = join(scratch, "config.json");
    writeFileSync(config, `{"port": 4180, "pad": "${"x".repeat(2_000)}"}`);
    ev("t-guard", "g1", { type: "turn.started" });
    ev("t-guard", "g2", { type: "item.started", itemType: "tool", itemId: "f1", title: "edit", verb: "Edit" });
    ev("t-guard", "g3", { type: "item.completed", itemType: "tool", itemId: "f1", ok: true, writes: [config] });
    const shell = (id: string, actions: object[], output: string) => [
      { method: "item/started", params: { item: { id, type: "commandExecution", command: "x", commandActions: actions } } },
      { method: "item/completed", params: { item: { id, type: "commandExecution", status: "completed", exitCode: 0, command: "x", commandActions: actions, aggregatedOutput: output } } },
    ];
    expect((await forkTurn("t-guard", [], "config.json says 4180.")).result).toMatchObject({ route: "handoff" });
    const read = shell("c1", [{ type: "read", command: "cat config.json", name: "config.json", path: config }], "{}");
    expect((await forkTurn("t-guard", read, "config.json says 4180.")).result).toMatchObject({ route: "answer" });
    const search = shell("c2", [{ type: "search", command: "rg port", query: "port", path: scratch }], 'config.json:1:{"port": 4180');
    expect((await forkTurn("t-guard", search, "config.json says 4180.")).result).toMatchObject({ route: "answer" });
    const miss = shell("c3", [{ type: "search", command: "rg port", query: "port", path: "src" }], "src/server.js:3:port");
    expect((await forkTurn("t-guard", miss, "config.json says 4180.")).result).toMatchObject({ route: "handoff" });
  });
});

describe("forkCodex (fake app-server)", () => {
  it("declines every approval request", async () => {
    const dump = join(scratch, "approval.json");
    const fixture = join(scratch, "no-frames.json");
    writeFileSync(fixture, "[]");
    const handle = forkCodex(
      {
        cli: FAKE_CLI,
        args: ["app-server"],
        env: { ...process.env, FAKE_CODEX_MODE: "approval", FAKE_CODEX_DUMP: dump, FAKE_CODEX_TOOL_FIXTURE: fixture },
        cwd: scratch,
        policy: {},
        home: scratch,
        cursor: "codex-thread-1",
      },
      { threadId: "t", text: "delete it" },
    );
    const events: SideEvent[] = [];
    handle.onEvent((event) => events.push(event));
    await vi.waitFor(() => expect(existsSync(dump)).toBe(true));
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ decision: "denied" });
    expect(events).toContainEqual({ type: "tool", name: "approval" });
    await handle.close();
    expect(alive(handle.live.pid)).toBe(false);
    expect(existsSync(handle.live.tempDir)).toBe(false);
  });
});
