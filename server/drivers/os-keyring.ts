// The one place Wink runs the OS credential tool (Windows cmdkey, macOS security).
// No test process reaches the real one: a Vitest worker and every server or script it spawns through
// server/testing/harness-auth.ts (attached to its test home) get a store that refuses everything instead.
import { execFile, type ExecFileException, type ExecFileOptionsWithStringEncoding } from "node:child_process";

import { shouldGuardTestData } from "../../companion/src/test-profile.ts";

export type KeyringExec = (
  file: "cmdkey.exe" | "security",
  args: string[],
  options: ExecFileOptionsWithStringEncoding,
  done: (error: ExecFileException | null, stdout: string) => void,
) => void;

const osKeyringTool: KeyringExec = (file, args, options, done) => {
  execFile(file, args, { ...options, windowsHide: true }, (error, stdout) => done(error, stdout));
};

/** The store every test process gets: the user's real one stays theirs whatever HOME says. */
export const refusingKeyringTool: KeyringExec = (file, args, _options, done) => {
  done(Object.assign(new Error("tests never run the OS keyring tool"), { cmd: [file, ...args].join(" ") }), "");
};

let replaced: KeyringExec | undefined;

function keyringTool(): KeyringExec {
  return replaced ?? (shouldGuardTestData() ? refusingKeyringTool : osKeyringTool);
}

export const runKeyringTool: KeyringExec = (file, args, options, done) => keyringTool()(file, args, options, done);

/** Runs `tool` in place of the OS credential tool. */
export function replaceKeyringTool(tool: KeyringExec): void {
  replaced = tool;
}

export function usesOsKeyringTool(): boolean {
  return keyringTool() === osKeyringTool;
}
