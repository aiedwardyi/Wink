import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderInstance } from "../contracts.ts";
import * as procs from "../procs.ts";
import { ClaudeDriver } from "./claude.ts";

let instance: ProviderInstance;
afterEach(async () => { await instance?.dispose(); vi.restoreAllMocks(); });

function fake(usage: unknown, retry = false, isError = false) {
  let calls = 0;
  return vi.spyOn(procs, "spawnCli").mockImplementation((_cli, argv) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    const rejectLean = retry && calls++ === 0;
    child.stdin.on("finish", () => queueMicrotask(() => {
      if (rejectLean) child.stderr.write("error: unknown option '--safe-mode'");
      else child.stdout.write(argv[argv.indexOf("--output-format") + 1] === "json" ? JSON.stringify({ result: "reply", is_error: isError, usage }) : "reply\n");
      child.emit("close", rejectLean ? 1 : 0);
    }));
    return child as unknown as ReturnType<typeof procs.spawnCli>;
  });
}

const create = async () => instance = await ClaudeDriver.create({ instanceId: "text", displayName: undefined, environment: {}, enabled: true, config: { ...ClaudeDriver.defaultConfig(), cli: "fixture-cli" } });

describe("Claude text usage", () => {
  it.each(["lean", "plain", "retry"])("reports Haiku input, cache creation, cache read and output once on %s", async (kind) => {
    const spawn = fake({ input_tokens: 2, cache_creation_input_tokens: 6_425, cache_read_input_tokens: 2_238, output_tokens: 1_052, output_tokens_details: { thinking_tokens: 949 } }, kind === "retry");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await create();
    const onUsage = vi.fn();
    await expect(instance.generateText!("cleanup", { lean: kind !== "plain", ephemeral: true, onUsage })).resolves.toBe("reply");
    expect(onUsage).toHaveBeenLastCalledWith({ input: 8_665, output: 1_052, cachedInput: 2_238, cacheCreation: 6_425 });
    expect(onUsage.mock.calls.filter(([usage]) => usage)).toHaveLength(1);
    for (const [, argv] of spawn.mock.calls) expect(argv[argv.indexOf("--output-format") + 1]).toBe("json");
  });

  it.each([undefined, {}, { input_tokens: 2 }, { input_tokens: -1, output_tokens: 5 }])("leaves unusable usage unreported: %s", async (usage) => {
    fake(usage);
    await create();
    const onUsage = vi.fn();
    await expect(instance.generateText!("cleanup", { onUsage })).resolves.toBe("reply");
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("rejects an error result even when the helper exits successfully", async () => {
    fake({ input_tokens: 2, output_tokens: 5 }, false, true);
    await create();
    await expect(instance.generateText!("cleanup", { onUsage: vi.fn() })).rejects.toThrow();
  });

  it("keeps text output for helpers without a usage callback", async () => {
    const spawn = fake(undefined);
    await create();
    await expect(instance.generateText!("summary")).resolves.toBe("reply");
    expect(spawn.mock.calls[0]![1]).toContain("text");
  });
});
