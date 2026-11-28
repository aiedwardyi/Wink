// Preloaded with --import into a harness boot: appends a line to SPAWN_LOG for each fake engine CLI started.
import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const log = process.env.SPAWN_LOG!;
const spawn = childProcess.spawn;
// SAFETY: the wrapper passes every argument through to the real spawn and returns its child.
childProcess.spawn = ((command: string, args?: readonly string[], options?: childProcess.SpawnOptions) => {
  const fake = [command, ...(args ?? [])].map(String).find((part) => /fake-[\w-]+\.ts/.test(part))?.match(/fake-[\w-]+\.ts/)?.[0];
  if (fake && !(args ?? []).includes("--version")) appendFileSync(log, `${JSON.stringify({ fake, args: (args ?? []).map(String) })}\n`);
  return spawn(command, args ?? [], options ?? {});
}) as typeof childProcess.spawn;
syncBuiltinESMExports();
