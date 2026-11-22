// The one place Wink runs the OS credential tool (Windows cmdkey, macOS security).
// Every test swaps in a fake store here (server/testing/setup.ts), so no test reaches the real one.
import { execFile, type ExecFileException, type ExecFileOptionsWithStringEncoding } from "node:child_process";

export type KeyringExec = (
  file: "cmdkey.exe" | "security",
  args: string[],
  options: ExecFileOptionsWithStringEncoding,
  done: (error: ExecFileException | null, stdout: string) => void,
) => void;

const osKeyringTool: KeyringExec = (file, args, options, done) => {
  execFile(file, args, options, (error, stdout) => done(error, stdout));
};

let keyringTool = osKeyringTool;

export const runKeyringTool: KeyringExec = (file, args, options, done) => keyringTool(file, args, options, done);

/** Runs `tool` in place of the OS credential tool: tests install a fake store before any test runs. */
export function replaceKeyringTool(tool: KeyringExec): void {
  keyringTool = tool;
}

export function usesOsKeyringTool(): boolean {
  return keyringTool === osKeyringTool;
}
