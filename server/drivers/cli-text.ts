import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProviderInstance } from "../contracts.ts";
import { killCliTree, spawnCli } from "../procs.ts";

type Env = Record<string, string | undefined>;

export interface CliTextRun {
  cwd: string;
  stdout: string;
  env: Env;
}

export interface CliTextSpec {
  name: string;
  model: string;
  timeoutMs: number;
  /** The prompt rides a file: a summary prompt on argv blows the Windows command line. */
  command(promptFile: string): Promise<{ cli: string; args: string[]; env: Env }>;
  parse(stdout: string): string;
  cleanup?(run: CliTextRun): void;
}

export interface CliText {
  generateText: NonNullable<ProviderInstance["generateText"]>;
  textModel: string;
  textTimeoutMs: number;
  dispose(): void;
}

export interface CliTextContext {
  cli(): Promise<string>;
  env(): Env;
}

export function createCliText(spec: CliTextSpec): CliText {
  const controllers = new Set<AbortController>();
  let disposed = false;

  const generateText: CliText["generateText"] = async (prompt, opts) => {
    if (disposed) throw new Error(`${spec.name} text helper disposed`);
    const controller = new AbortController();
    controllers.add(controller);
    const onAbort = () => controller.abort();
    opts?.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts?.signal?.aborted) controller.abort();
    const timer = setTimeout(() => controller.abort(new Error(`${spec.name} text timed out`)), opts?.timeoutMs ?? spec.timeoutMs);
    const cwd = mkdtempSync(join(tmpdir(), "wink-text-"));
    const run: CliTextRun = { cwd, stdout: "", env: {} };
    const failure = () => controller.signal.reason instanceof Error ? controller.signal.reason : new Error(`${spec.name} text aborted`);
    try {
      const promptFile = join(cwd, "prompt.txt");
      writeFileSync(promptFile, prompt);
      const { cli, args, env } = await spec.command(promptFile);
      run.env = env;
      if (controller.signal.aborted) throw failure();
      run.stdout = await new Promise<string>((resolve, reject) => {
        const child = spawnCli(cli, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let bytes = 0;
        let error: Error | null = null;
        const stop = (reason: Error) => {
          error ??= reason;
          killCliTree(child);
        };
        const abort = () => stop(failure());
        controller.signal.addEventListener("abort", abort, { once: true });
        child.on("error", (err) => {
          controller.signal.removeEventListener("abort", abort);
          reject(error ?? err);
        });
        // Settle on close, so cleanup never races a CLI still writing its session.
        child.on("close", (code) => {
          controller.signal.removeEventListener("abort", abort);
          if (error) reject(error);
          else if (code !== 0) reject(new Error(`${spec.name} text exited with code ${code}`));
          else resolve(stdout);
        });
        child.stderr!.resume();
        child.stdout!.setEncoding("utf8");
        child.stdout!.on("data", (chunk: string) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 2_000_000) return stop(new Error(`${spec.name} text output exceeded 2 MB`));
          stdout += chunk;
        });
      });
      return spec.parse(run.stdout);
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
      opts?.signal?.removeEventListener("abort", onAbort);
      try { spec.cleanup?.(run); } catch { /* best-effort cleanup */ }
      try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    }
  };

  return {
    generateText,
    textModel: spec.model,
    textTimeoutMs: spec.timeoutMs,
    dispose: () => {
      disposed = true;
      for (const controller of controllers) controller.abort(new Error(`${spec.name} text helper disposed`));
    },
  };
}
