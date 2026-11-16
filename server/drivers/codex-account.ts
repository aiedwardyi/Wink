import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import type { AccountContext } from "../account-policy.ts";
import { spawnCli } from "../procs.ts";
import { codexDirect } from "./codex-direct.ts";
import { awaitDyingAppServers, codexHome, retireAppServer } from "./codex-catalog.ts";
import { accountLabel, storedAccount } from "./auth-status.ts";

export interface CodexAccount { type?: string; authenticated?: boolean; label?: string; identity?: string }
const responseSchema = z.object({ account: z.object({ type: z.string(), email: z.string().nullish() }).nullable() });
const authSchema = z.object({ auth_mode: z.string().nullish(), tokens: z.object({ id_token: z.string() }) });

export function codexApiKeyAccount(env: Record<string, string | undefined>): boolean {
  try {
    return authSchema.pick({ auth_mode: true }).safeParse(JSON.parse(readFileSync(join(codexHome(env), "auth.json"), "utf8"))).data?.auth_mode === "apikey";
  } catch { return false; }
}

export function codexAccount(env: Record<string, string | undefined>): string | undefined {
  return storedAccount(join(codexHome(env), "auth.json"), (auth) => {
    const parsed = authSchema.safeParse(auth);
    if (!parsed.success || parsed.data.auth_mode === "apikey") return undefined;
    const claims: unknown = JSON.parse(Buffer.from(parsed.data.tokens.id_token.split(".")[1] ?? "", "base64url").toString("utf8"));
    const named = z.object({ email: z.unknown().optional(), name: z.unknown().optional() }).safeParse(claims);
    return named.success ? accountLabel(named.data.email, named.data.name) : undefined;
  });
}

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
    const child = spawnCli(cli, ["app-server"], { env, cwd: homedir(), stdio: ["pipe", "pipe", "pipe"], direct: codexDirect, ...(account ? { account, accountDriver: "codex" } : {}) });
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
