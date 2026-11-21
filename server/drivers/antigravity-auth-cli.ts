// Signs agy in or out over its ACP server: it has no login or logout subcommand.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { resolveCliSpawn } from "../env-path.ts";
import { killCliTree } from "../kill-cli-tree.ts";

const AUTH_URL = /https:\/\/accounts\.google\.com\/[^\s"'\\]+/;

async function main(mode: string): Promise<number> {
  const { command, args } = resolveCliSpawn(process.env.OMB_AGY_CLI || "agy", ["acp"]);
  const env = { ...process.env };
  delete env.OMB_AGY_CLI;
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, env });
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
    console.error(error instanceof Error ? error.message : "failed");
    return 1;
  } finally {
    killCliTree(child);
  }
}

const mode = process.argv[2];
if (mode === "login" || mode === "logout") process.exit(await main(mode));
console.error("usage: antigravity-auth-cli login|logout");
process.exit(2);
