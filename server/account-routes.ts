import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import { AccountError, isInstanceId } from "./accounts.ts";
import type { AccountLifecycle } from "./account-lifecycle.ts";
import { AccountNameError, type AccountNames } from "./account-names.ts";
import type { ProviderRegistry } from "./harness/registry.ts";
import { json, readBody } from "./http-helpers.ts";

const signInSchema = z.object({ device: z.boolean().optional() }).strict();
const addSchema = signInSchema.extend({ of: z.string().refine(isInstanceId) });
const removalSchema = z.object({ destinationId: z.string().refine(isInstanceId).optional() }).strict();
const codeSchema = z.object({ generation: z.number().int().positive(), code: z.string().min(1).max(4096).refine((code) => !/[^!-~]/.test(code)) }).strict();
const nameSchema = z.object({ nickname: z.string().nullable() }).strict();

export function createAccountRoutes(lifecycle: AccountLifecycle, registry: ProviderRegistry, deps: { names?: AccountNames; onNamesChanged?: () => void } = {}) {
  return async (req: IncomingMessage, res: ServerResponse, method: string, path: string): Promise<boolean> => {
    const route = /^\/api\/accounts(?:\/([^/]+)(?:\/(sign-in\/code|sign-in|sign-out|default|destination))?)?$/.exec(path);
    const nameRoute = deps.names && /^\/api\/accounts\/([^/]+)\/name$/.exec(path);
    const legacy = /^\/api\/instances\/([^/]+)\/(sign-in|sign-out)$/.exec(path);
    const managed = legacy && (lifecycle.accounts.get(legacy[1]) || lifecycle.accounts.drains[legacy[1]] || lifecycle.accounts.snapshot.some((row) => row.of === legacy[1])
      || (legacy[2] === "sign-in" && registry.accountBlocked(legacy[1])));
    if (!route && !managed && !nameRoute) return false;
    const id = nameRoute?.[1] ?? route?.[1] ?? legacy?.[1];
    const action = route?.[2] ?? legacy?.[2];
    try {
      if (nameRoute) {
        if (method !== "POST") json(res, 405, { error: "Unsupported account operation" });
        else {
          deps.names!.sync(lifecycle.accounts.list());
          if (!deps.names!.get(id!)) {
            json(res, 404, { error: "Unknown account", code: "unknown-account" });
            return true;
          }
          const parsed = nameSchema.safeParse(await body(req));
          if (!parsed.success) {
            json(res, 400, { error: "Invalid nickname", code: "invalid-character" });
            return true;
          }
          deps.names!.setNickname(id!, parsed.data.nickname);
          const { number, nickname, name } = deps.names!.get(id!)!;
          json(res, 200, { id, number, nickname, name });
          deps.onNamesChanged?.();
        }
        return true;
      }
      if (id && !isInstanceId(id)) throw new AccountError("Invalid account id", 400);
      if (id && action === "sign-in" && method === "GET") {
        const result = legacy ? registry.signIn(id) : lifecycle.signInResult(id) ?? (lifecycle.accounts.list().some((row) => row.id === id) ? { state: registry.logins.state(id), ...registry.logins.capture(id) } : null);
        if (!result) throw new AccountError("Unknown account", 404);
        json(res, 200, result);
      } else if (id && action === "sign-in/code" && method === "POST") {
        if (!lifecycle.accounts.get(id) || registry.get(id)?.driverKind !== "claudeAgent") throw new AccountError("Unknown managed Claude account", 404);
        const parsed = codeSchema.safeParse(await body(req));
        if (!parsed.success) throw new AccountError("A login generation and one code are required", 400);
        if (!registry.logins.submit(id, parsed.data.generation, parsed.data.code)) throw new AccountError("This sign-in is no longer waiting for a code", 409);
        json(res, 200, {});
      } else if (id && action === "destination" && method === "GET") {
        if (!lifecycle.bots) throw new AccountError("Bot account routing is unavailable", 503);
        const instances = await registry.describeCached();
        const destination = lifecycle.accounts.list().find((account) => {
          const instance = instances.find((row) => row.instanceId === account.id);
          if (instance?.snapshot.state !== "available" || instance.snapshot.authenticated !== true) return false;
          try { lifecycle.bots!.destination(id, account.id); return true; }
          catch (error) { if (!(error instanceof AccountError)) throw error; return false; }
        });
        if (!destination) throw new AccountError("No ready account can take over this profile", 400);
        json(res, 200, { destinationId: destination.id });
      } else if (!id && method === "GET") {
        const instances = await registry.describeCached();
        const accounts = lifecycle.accounts.list();
        deps.names?.sync(accounts);
        json(res, 200, { accounts: accounts.map((account) => {
          const instance = instances.find((row) => row.instanceId === account.id);
          const named = deps.names?.get(account.id);
          return { ...account, ...(!account.error && lifecycle.accounts.isDefault(account.id) ? { default: true } : {}), snapshot: account.error ? { state: "unavailable", reason: account.error } : instance?.snapshot, loginState: instance?.loginState, loginError: instance?.loginError,
            ...(named ? { number: named.number, nickname: named.nickname, name: named.name } : {}),
            state: account.existing && registry.accountBlocked(account.id) ? "stopped" : account.state,
            models: instance?.models, effortLevels: instance?.capabilities.effortLevels,
            ...(lifecycle.accounts.drains[account.id] ? { drain: lifecycle.accounts.drains[account.id] } : {}),
          };
        }) });
      } else if (!id && method === "POST") {
        const parsed = addSchema.safeParse(await body(req));
        if (!parsed.success) throw new AccountError("An engine base id and optional device flag are required", 400);
        json(res, 200, await lifecycle.add(parsed.data.of, parsed.data.device));
      } else if (id && action === "default" && method === "POST") {
        json(res, 200, await lifecycle.useForBots(id));
      } else if (id && action === "sign-in" && method === "POST") {
        const parsed = signInSchema.safeParse(await body(req));
        if (!parsed.success) throw new AccountError("device must be a boolean", 400);
        json(res, 200, await lifecycle.signIn(id, parsed.data.device));
      } else if (id && action === "sign-in" && method === "DELETE") json(res, 200, await lifecycle.cancel(id));
      else if (id && ((action === "sign-out" && method === "POST") || (!action && method === "DELETE"))) {
        const parsed = removalSchema.safeParse(method === "POST" ? await body(req) : {});
        if (!parsed.success) throw new AccountError("destinationId must name an account", 400);
        json(res, 200, await lifecycle.remove(id, parsed.data.destinationId));
      } else json(res, 405, { error: "Unsupported account operation" });
    } catch (error) {
      const status = error instanceof Error && "status" in error && typeof error.status === "number" ? error.status : 500;
      if (nameRoute) json(res, status, error instanceof AccountNameError ? { error: error.message, code: error.code } : status === 400 ? { error: "Invalid nickname", code: "invalid-character" } : { error: "Account operation failed" });
      else if (status < 500 || error instanceof AccountError) {
        const code = (error as { code?: unknown }).code;
        json(res, status, { error: (error as Error).message, ...(typeof code === "string" ? { code } : {}) });
      } else json(res, status, { error: "Account operation failed" });
    }
    return true;
  };
}

async function body(req: IncomingMessage) {
  if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) throw new AccountError("content-type must be application/json", 415);
  return readBody(req);
}
