// Preloaded with --import into a harness boot: appends every Claude provider
// call, CLI spawn and lifecycle event to GOLDEN_LOG as JSON lines.
import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

import type { ProviderInstance } from "../contracts.ts";
import { ClaudeDriver } from "../drivers/claude.ts";

const log = process.env.GOLDEN_LOG!;
const bootEnv = { ...process.env };
const LIFECYCLE = new Set(["session.started", "session.exited", "turn.started", "turn.completed", "turn.retrying", "request.opened"]);

const write = (entry: Record<string, unknown>) =>
  appendFileSync(log, `${JSON.stringify(entry, (_key, value) => (typeof value === "function" || value instanceof AbortSignal ? undefined : value))}\n`);

const envDiff = (env: NodeJS.ProcessEnv | undefined) => {
  const out: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(env ?? bootEnv)) if (bootEnv[key] !== value) out[key] = value ?? null;
  for (const key of Object.keys(bootEnv)) if (env && !(key in env)) out[key] = null;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
};

const spawn = childProcess.spawn;
childProcess.spawn = ((command: string, args: readonly string[], options?: childProcess.SpawnOptions) => {
  if ([command, ...(args ?? [])].some((part) => String(part).includes("fake-claude-cli"))) {
    write({ kind: "spawn", args: (args ?? []).map(String), env: envDiff(options?.env) });
  }
  return spawn(command, args, options ?? {});
}) as typeof childProcess.spawn;
syncBuiltinESMExports();

const create = ClaudeDriver.create.bind(ClaudeDriver);
ClaudeDriver.create = async (input) => {
  const instance: ProviderInstance = await create(input);
  const id = instance.instanceId;
  instance.adapter.onEvent((event) => {
    if (LIFECYCLE.has(event.type)) write({ kind: "event", instance: id, type: event.type, threadId: event.threadId, turnId: event.turnId });
  });
  const sendTurn = instance.adapter.sendTurn.bind(instance.adapter);
  instance.adapter.sendTurn = (turn) => {
    write({ kind: "sendTurn", instance: id, input: { ...turn, trace: undefined } });
    return sendTurn(turn);
  };
  for (const name of ["generateText", "reviewPermission", "fork"] as const) {
    const helper = instance[name] as ((...args: unknown[]) => unknown) | undefined;
    if (!helper) continue;
    (instance as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
      write({ kind: "helper", instance: id, name, args });
      return helper.apply(instance, args);
    };
  }
  return instance;
};
