import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { z } from "zod";

import type { AccountContext } from "../account-policy.ts";
import { spawnCli } from "../procs.ts";
import { awaitDyingAppServers, codexHome, retireAppServer } from "./codex-catalog.ts";

export interface CodexAccount { type?: string; authenticated?: boolean; label?: string; identity?: string }
const responseSchema = z.object({ account: z.object({ type: z.string(), email: z.string().nullish() }).nullable() });

export function parseCodexAccount(value: unknown): CodexAccount {
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) return {};
  const account = parsed.data.account;
  if (!account) return { authenticated: false };
  const label = account.type === "chatgpt" ? account.email?.trim() || undefined : undefined;
  return { type: account.type, authenticated: true, label,
    ...(label ? { identity: createHash("sha256").update(label.toLowerCase()).digest("hex") } : {}),
  };
}

export async function readCodexAccount(cli: string, env: NodeJS.ProcessEnv, account?: AccountContext): Promise<CodexAccount> {
  const home = account?.home ?? codexHome(env);
  await awaitDyingAppServers(2_000, home);
  return new Promise((resolve) => {
    const child = spawnCli(cli, ["app-server"], { env, cwd: homedir(), stdio: ["pipe", "pipe", "pipe"], ...(account ? { account, accountDriver: "codex" } : {}) });
    let buffer = "";
    let settled = false;
    const finish = (value: CodexAccount = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      retireAppServer(child, home);
      resolve(value);
    };
    const send = (method: string, id?: number, params: unknown = {}) => {
      try { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, id, params })}\n`); } catch { finish(); }
    };
    const timer = setTimeout(() => finish(), 8_000);
    child.on("error", () => finish());
    child.on("close", () => finish());
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 1_000_000) return finish();
      let newline: number;
      while (!settled && (newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.error) return finish();
        if (message.id === 1) { send("initialized"); send("account/read", 2, { refreshToken: false }); }
        else if (message.id === 2) finish(parseCodexAccount(message.result));
      }
    });
    send("initialize", 1, { clientInfo: { name: "wink_accounts", version: "1" } });
  });
}
