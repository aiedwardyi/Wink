// Signs agy in or out over its ACP server: it has no login or logout subcommand.
// agy before 1.5 has no ACP server either, so a logout there deletes agy's saved
// sign-in from the OS keyring entry OMB_AGY_KEYRING names (service:account).
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { resolveCliSpawn } from "../env-path.ts";
import { killCliTree } from "../kill-cli-tree.ts";
import { forgetAntigravitySignIn } from "./antigravity-auth.ts";

const AUTH_URL = /https:\/\/accounts\.google\.com\/[^\s"'\\]+/;
// What agy 1.3 prints for `agy acp` before exiting with code 2.
const NO_ACP = /unexpected argument "acp"/;

async function main(mode: string): Promise<number> {
  const { command, args } = resolveCliSpawn(process.env.OMB_AGY_CLI || "agy", ["acp"]);
  const keyring = process.env.OMB_AGY_KEYRING;
  const env = { ...process.env };
  delete env.OMB_AGY_CLI;
  delete env.OMB_AGY_KEYRING;
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
  child.stdin.on("error", () => {});
  const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  let next = 0;
  const closed = new Promise<never>((_, reject) => child.once("close", () => reject(new Error("agy closed before answering"))));
  closed.catch(() => {});
  child.once("error", () => { for (const call of pending.values()) call.reject(new Error("agy could not start")); });
  createInterface({ input: child.stdout }).on("line", (line) => {
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
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: next, method, params })}\n`);
    }),
    closed,
  ]);
  try {
    await call("initialize", { protocolVersion: 1, clientCapabilities: {} });
    if (mode === "login") await call("authenticate", { methodId: "oauth-personal" });
    else await call("logout", {});
    return 0;
  } catch (error) {
    if (NO_ACP.test(stderr)) {
      if (mode === "logout" && keyring && await forgetAntigravitySignIn(keyring)) return 0;
      console.error(`agy is older than 1.5 and has no ACP server, so it could not ${mode === "login" ? "sign in" : "sign out"} here`);
      return 1;
    }
    const reason = stderr.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    console.error([error instanceof Error ? error.message : "failed", reason].filter(Boolean).join(": "));
    return 1;
  } finally {
    killCliTree(child);
  }
}

// `agy acp --login` prints the link and reads the pasted code on stdin.
function pasteLogin(): Promise<number> {
  const { command, args } = resolveCliSpawn(process.env.OMB_AGY_CLI || "agy", ["acp", "--login"]);
  const env = { ...process.env };
  delete env.OMB_AGY_CLI;
  delete env.OMB_AGY_KEYRING;
  const child = spawn(command, args, { stdio: "inherit", windowsHide: true, env });
  return new Promise((resolve) => {
    child.once("error", () => resolve(1));
    child.once("close", (code) => resolve(code ?? 1));
  });
}

const mode = process.argv[2];
if (mode === "login" && process.argv[3] === "--paste") process.exit(await pasteLogin());
if (mode === "login" || mode === "logout") process.exit(await main(mode));
console.error("usage: antigravity-auth-cli login|logout");
process.exit(2);
