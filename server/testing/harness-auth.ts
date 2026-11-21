import { spawn, type ChildProcess, type ChildProcessByStdio, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";

import { harnessTestHome } from "../../companion/src/test-profile.ts";

const profilePreload = new URL("./harness-profile.ts", import.meta.url).href;

const tokens = new Map<string, Promise<string>>();
const stderrTails = new Map<string, string[]>();
const TAIL_LINES = 40;

export async function harnessToken(origin: string): Promise<string> {
  return await tokens.get(origin) ?? "";
}

export function spawnTestNode(command: string, args: string[], options: SpawnOptions & { stdio: ["pipe", "pipe", "pipe"] }): ChildProcessWithoutNullStreams;
export function spawnTestNode(command: string, args: string[], options: SpawnOptions & { stdio: ["pipe", "pipe", "inherit"] }): ChildProcessByStdio<Writable, Readable, null>;
export function spawnTestNode(command: string, args: string[], options: SpawnOptions): ChildProcess;
export function spawnTestNode(command: string, args: string[], options: SpawnOptions): ChildProcess {
  let env = options.env ?? process.env;
  let profile;
  if (env?.VITEST !== undefined) {
    profile = harnessTestHome(env.HOME);
    if (!profile || env.USERPROFILE !== profile.home) {
      throw new Error("Use createFixtureHome from server/testing/test-home.ts for a Vitest child HOME and USERPROFILE");
    }
    const temp = tmpdir();
    env = { ...env, TEMP: temp, TMP: temp, TMPDIR: temp };
    args = ["--import", profilePreload, ...args];
  }
  // stdio and windowsHide sit after the spread deliberately: the ipc channel
  // is load-bearing for the token handshake below, and no harness wants a console.
  const stdio = Array.isArray(options.stdio) ? options.stdio : [];
  const child = spawn(command, args, { ...options, env,
    stdio: [stdio[0] ?? "ignore", stdio[1] ?? "pipe", stdio[2] ?? "pipe", "ipc"], windowsHide: true });
  const childProfile = profile;
  if (childProfile) child.once("message", (message) => {
    if (message === "wink:test-profile") child.send(childProfile, () => {});
  });
  return child;
}

export function spawnHarness(command: string, args: string[], options: SpawnOptions) {
  const child = spawnTestNode(command, args, options);
  const origin = `http://127.0.0.1:${options.env?.OMB_PORT ?? options.env?.OGB_PORT ?? 8799}`;
  const token = new Promise<string>((resolve) => {
    child.on("message", (message) => {
      const value = z.object({ type: z.literal("orbit:api-token"), token: z.string() }).safeParse(message);
      if (value.success) resolve(value.data.token);
    });
    child.once("exit", () => resolve(""));
  });
  tokens.set(origin, token);
  const tail: string[] = [];
  stderrTails.set(origin, tail);
  let partial = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    const lines = (partial + chunk.toString()).split("\n");
    partial = lines.pop() ?? "";
    tail.push(...lines);
    if (tail.length > TAIL_LINES) tail.splice(0, tail.length - TAIL_LINES);
  });
  child.once("exit", () => {
    if (tokens.get(origin) === token) tokens.delete(origin);
  });
  return child;
}

export async function runTestNode(args: string[], options: SpawnOptions = {}) {
  const child = spawnTestNode(process.execPath, args, options);
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk; });
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk; });
  const [status] = await once(child, "close");
  return { status, stdout, stderr };
}

const resetError = z.object({ cause: z.object({ code: z.literal("ECONNRESET") }) });

// A reset is retried once for idempotent methods only: a replayed POST could dispatch twice.
// The warn keeps every reset visible in CI logs, since a green retry would otherwise hide it.
export const harnessFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const send = async () => {
    const token = tokens.get(url.origin);
    // comms.test.ts intentionally checks unauthenticated internal requests.
    if (!token || !url.pathname.startsWith("/api/") || url.pathname.startsWith("/api/internal/") || url.pathname === "/api/health") {
      return fetch(input, init);
    }
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has("authorization")) headers.set("authorization", `Bearer ${await token}`);
    return fetch(input, { ...init, headers, redirect: "error" });
  };
  try {
    return await send();
  } catch (error) {
    if (!resetError.safeParse(error).success || (method !== "GET" && method !== "HEAD")) throw error;
    const tail = (stderrTails.get(url.origin) ?? []).join(" | ");
    console.warn(`${new Date().toISOString()} harnessFetch ECONNRESET ${method} ${url.pathname}, retrying once. server stderr: ${tail || "(empty)"}`);
    try {
      return await send();
    } catch {
      throw error;
    }
  }
};
