import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { ProviderInstance, SideEvent } from "../contracts.ts";
import * as procs from "../procs.ts";
import { quickAsk, sideIdle } from "../side-chat.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { CodexDriver } from "./codex.ts";
import { forkCodex } from "./codex-fork.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-codex-app-server.ts");
const LEDGER = join(DATA_DIR, "side-chat", "live.json");
const envKeys = ["FAKE_CODEX_MODE", "FAKE_CODEX_DUMP", "FAKE_CODEX_TOOL_FIXTURE"];
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
