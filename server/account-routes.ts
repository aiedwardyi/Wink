import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import { AccountError, isInstanceId } from "./accounts.ts";
import type { AccountLifecycle } from "./account-lifecycle.ts";
import type { ProviderRegistry } from "./harness/registry.ts";
import { json, readBody } from "./http-helpers.ts";

const signInSchema = z.object({ device: z.boolean().optional() }).strict();
const addSchema = signInSchema.extend({ of: z.string().refine(isInstanceId) });
const removalSchema = z.object({ destinationId: z.string().refine(isInstanceId).optional() }).strict();

export function createAccountRoutes(lifecycle: AccountLifecycle, registry: ProviderRegistry) {
  return async (req: IncomingMessage, res: ServerResponse, method: string, path: string): Promise<boolean> => {
    const route = /^\/api\/accounts(?:\/([^/]+)(?:\/(sign-in|sign-out|default))?)?$/.exec(path);
    const legacy = /^\/api\/instances\/([^/]+)\/(sign-in|sign-out)$/.exec(path);
    const managed = legacy && (lifecycle.accounts.get(legacy[1]) || lifecycle.accounts.drains[legacy[1]] || lifecycle.accounts.snapshot.some((row) => row.of === legacy[1]));
    if (!route && !managed) return false;
    const id = route?.[1] ?? legacy?.[1];
    const action = route?.[2] ?? legacy?.[2];
    try {
      if (id && !isInstanceId(id)) throw new AccountError("Invalid account id", 400);
      if (id && action === "sign-in" && method === "GET") {
        const result = legacy ? registry.signIn(id) : lifecycle.signInResult(id) ?? (lifecycle.accounts.list().some((row) => row.id === id) ? { state: registry.logins.state(id), ...registry.logins.capture(id) } : null);
        if (!result) throw new AccountError("Unknown account", 404);
        json(res, 200, result);
      } else if (!id && method === "GET") {
        const instances = await registry.describeCached();
        json(res, 200, { accounts: lifecycle.accounts.list().map((account) => {
          const instance = instances.find((row) => row.instanceId === account.id);
          return { ...account, ...(lifecycle.accounts.isDefault(account.id) ? { default: true } : {}), snapshot: instance?.snapshot, loginState: instance?.loginState, loginError: instance?.loginError,
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
      json(res, status, { error: status < 500 || error instanceof AccountError ? (error as Error).message : "Account operation failed" });
    }
    return true;
  };
}

async function body(req: IncomingMessage) {
  if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) throw new AccountError("content-type must be application/json", 415);
  return readBody(req);
}
