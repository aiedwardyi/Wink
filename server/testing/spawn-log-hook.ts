// Preloaded with --import into a harness boot: appends a line to SPAWN_LOG when a fake engine CLI starts, is first
// written to, and exits.
import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const log = process.env.SPAWN_LOG!;
const write = (entry: { fake: string; id: number; event: "spawn" | "stdin" | "exit" }) => appendFileSync(log, `${JSON.stringify(entry)}\n`);
let next = 0;
const spawn = childProcess.spawn;
// SAFETY: the wrapper passes every argument through to the real spawn and returns its child.
childProcess.spawn = ((command: string, args?: readonly string[], options?: childProcess.SpawnOptions) => {
  const child = spawn(command, args ?? [], options ?? {});
  const fake = [command, ...(args ?? [])].map(String).find((part) => /fake-[\w-]+\.ts/.test(part))?.match(/fake-[\w-]+\.ts/)?.[0];
  if (!fake || (args ?? []).includes("--version")) return child;
  const id = ++next;
  write({ fake, id, event: "spawn" });
  child.once("exit", () => write({ fake, id, event: "exit" }));
  const stdin = child.stdin;
  if (stdin) {
    let written = false;
    const mark = () => { if (!written) write({ fake, id, event: "stdin" }); written = true; };
    for (const name of ["write", "end"] as const) {
      const original = stdin[name].bind(stdin);
      // SAFETY: write and end take data first and return a boolean or the stream; the result is passed through.
      const call = original as (...a: unknown[]) => boolean;
      // SAFETY: same arguments and result as the stream's own method; only the first data is noted.
      stdin[name] = ((...rest: unknown[]) => { if (rest[0] !== undefined && !(rest[0] instanceof Function)) mark(); return call(...rest); }) as typeof stdin.write & typeof stdin.end;
    }
  }
  return child;
}) as typeof childProcess.spawn;
syncBuiltinESMExports();
