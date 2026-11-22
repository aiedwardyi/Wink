// Signs agy in or out over its ACP server: it has no login or logout subcommand.
// agy before 1.5 has no ACP server, so the helper updates it once and carries on; Wink's turns keep auto-update off.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { resolveCliSpawn } from "../env-path.ts";
import { killCliTree } from "../kill-cli-tree.ts";

const AUTH_URL = /https:\/\/accounts\.google\.com\/[^\s"'\\]+/;
// What agy 1.3 prints for `agy acp` before exiting with code 2.
const NO_ACP = /unexpected argument "acp"/;
const OLD = "old";

function agy(args: string[], stdio: "pipe" | "inherit") {
  const { command, args: spawnArgs } = resolveCliSpawn(process.env.OMB_AGY_CLI || "agy", args);
  const env = { ...process.env };
  delete env.OMB_AGY_CLI;
  const child = spawn(command, spawnArgs, { stdio: [stdio, stdio, "pipe"], windowsHide: true, env });
  let stderr = "";
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4096);
    if (stdio === "inherit") process.stderr.write(chunk);
  });
  return { child, stderr: () => stderr };
}

const lines = (text: string) => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

async function acp(mode: string): Promise<number | typeof OLD> {
  const { child, stderr } = agy(["acp"], "pipe");
  child.stdin!.on("error", () => {});
  const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  let next = 0;
  const closed = new Promise<never>((_, reject) => child.once("close", () => reject(new Error("agy closed before answering"))));
  closed.catch(() => {});
  child.once("error", () => { for (const call of pending.values()) call.reject(new Error("agy could not start")); });
  createInterface({ input: child.stdout! }).on("line", (line) => {
    let message: { id?: number; error?: { message?: string } };
    try { message = JSON.parse(line); } catch { return; }
    const url = AUTH_URL.exec(JSON.stringify(message))?.[0];
    if (url) console.log(url);
    const call = message.id === undefined ? undefined : pending.get(message.id);
    if (!call) return;
    pending.delete(message.id!);
    if (message.error) call.reject(new Error(message.error.message || "agy refused"));
    else call.resolve();
  });
  const call = (method: string, params: Record<string, string | number | Record<string, never>>) => Promise.race([
    new Promise<void>((resolve, reject) => {
      pending.set(++next, { resolve, reject });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: next, method, params })}\n`);
    }),
    closed,
  ]);
  try {
    await call("initialize", { protocolVersion: 1, clientCapabilities: {} });
    if (mode === "login") await call("authenticate", { methodId: "oauth-personal" });
    else await call("logout", {});
    return 0;
  } catch (error) {
    if (NO_ACP.test(stderr())) return OLD;
    console.error([error instanceof Error ? error.message : "failed", lines(stderr())[0]].filter(Boolean).join(": "));
    return 1;
  } finally {
    killCliTree(child);
  }
}

// `agy acp --login` prints the link and reads the pasted code on stdin.
function pasteLogin(): Promise<number | typeof OLD> {
  const { child, stderr } = agy(["acp", "--login"], "inherit");
  return new Promise((resolve) => {
    child.once("error", () => resolve(1));
    child.once("close", (code) => resolve(code !== 0 && NO_ACP.test(stderr()) ? OLD : code ?? 1));
  });
}

/** Runs `agy update`: undefined once updated, else why it could not. */
function update(): Promise<string | undefined> {
  const { child, stderr } = agy(["update"], "pipe");
  child.stdin!.end();
  child.stdout!.resume();
  return new Promise((resolve) => {
    child.once("error", () => resolve("agy could not start"));
    child.once("close", (code) => resolve(code === 0 ? undefined : lines(stderr()).at(-1) ?? "failed"));
  });
}

async function updating(run: () => Promise<number | typeof OLD>): Promise<number> {
  const result = await run();
  if (result !== OLD) return result;
  const failed = await update();
  const retried = failed === undefined ? await run() : OLD;
  if (retried !== OLD) return retried;
  console.error(`agy is older than 1.5 and could not update itself${failed ? `: ${failed}` : ""}`);
  return 1;
}

const mode = process.argv[2];
if (mode === "login" && process.argv[3] === "--paste") process.exit(await updating(pasteLogin));
if (mode === "login" || mode === "logout") process.exit(await updating(() => acp(mode)));
console.error("usage: antigravity-auth-cli login|logout");
process.exit(2);
