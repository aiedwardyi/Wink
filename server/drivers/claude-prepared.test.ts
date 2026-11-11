import { once } from "node:events";
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../config.ts";
import * as procs from "../procs.ts";
import { recordEvents } from "../testing/events.ts";
import { ClaudeDriver } from "./claude.ts";
import { warmPool } from "./warm-pool.ts";

vi.mock("./warm-pool.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./warm-pool.ts")>();
  return {
    ...actual,
    warmPool: actual.createWarmPool({ totalmem: () => 4 * 1024 ** 3, freemem: () => 3 * 1024 ** 3, cpus: () => 4 }),
  };
});

const FAKE_CLI = fileURLToPath(new URL("../testing/fake-claude-cli.ts", import.meta.url));
const focus = { threadId: "t-prepared-a", approval: "ask" as const };

describe("Claude prepared children", () => {
  let instance: Awaited<ReturnType<typeof ClaudeDriver.create>>;
  let recorder: ReturnType<typeof recordEvents>;
  let children: ReturnType<typeof procs.spawnCli>[];

  beforeEach(async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    vi.stubEnv("OMB_CLAUDE_SESSION_IDLE_MS", "60000");
    instance = await ClaudeDriver.create({
      instanceId: "claude-prepared", displayName: "Claude", enabled: true,
      environment: {}, config: { cli: FAKE_CLI, permissionMode: "acceptEdits" },
    });
    recorder = recordEvents(instance.adapter);
    children = [];
    const spawn = procs.spawnCli;
    vi.spyOn(procs, "spawnCli").mockImplementation((...args) => {
      const child = spawn(...args);
      children.push(child);
      return child;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    recorder?.stop();
    const closed = children.filter((child) => child.exitCode === null && child.signalCode === null).map((child) => once(child, "close"));
    await instance?.dispose();
    await Promise.all(closed);
    await warmPool.closeAll("test");
  });

  const closeTurn = async (threadId: string) => {
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "one", approval: "ask" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const child = children.at(-1)!;
    const closed = once(child, "close");
    child.stdin.end();
    await closed;
  };

  it("counts a retiring prepared child until exit before admitting another", async () => {
    await closeTurn(focus.threadId);
    await closeTurn("t-prepared-b");
    await instance.prepare!(undefined, focus);
    const prepared = children.at(-1)!;
    const end = vi.spyOn(prepared.stdin, "end").mockReturnValue(prepared.stdin);
    const kill = procs.killCliTree;
    const killing = vi.spyOn(procs, "killCliTree").mockImplementation((child, stopped) => {
      if (child !== prepared) kill(child, stopped);
    });
    try {
      await instance.prepare!(undefined, { ...focus, threadId: "t-prepared-b" });
      expect(prepared.exitCode).toBeNull();
      expect(prepared.signalCode).toBeNull();
      expect(children).toHaveLength(3);
      expect(warmPool.stats()).toMatchObject({ reserved: 1, closing: 1, idle: 0 });
    } finally {
      end.mockRestore();
      killing.mockRestore();
      const closed = once(prepared, "close");
      prepared.stdin.end();
      await closed;
    }
    await vi.waitFor(() => expect(warmPool.stats().reserved).toBe(0));
    await instance.prepare!(undefined, { ...focus, threadId: "t-prepared-b" });
    expect(children).toHaveLength(4);
    expect(warmPool.stats()).toMatchObject({ reserved: 1, idle: 1 });
  });

  it.each(["bot deletion", "focus without a plan"])("retires a prepared child on %s", async (reason) => {
    await closeTurn(focus.threadId);
    await instance.prepare!(undefined, focus);
    const prepared = children.at(-1)!;
    const end = vi.spyOn(prepared.stdin, "end");
    if (reason === "bot deletion") await instance.adapter.interruptTurn(focus.threadId);
    else await instance.prepare!(undefined, { ...focus, threadId: "t-never-used" });
    expect(end).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(prepared.exitCode !== null || prepared.signalCode !== null).toBe(true));
    await vi.waitFor(() => expect(warmPool.stats().reserved).toBe(0));
    expect(children).toHaveLength(2);
  });
});
