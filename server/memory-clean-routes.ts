import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import { json, readBody } from "./http-helpers.ts";
import type { MemoryCleanSummary, MemoryCleanUndoResult } from "./memory-clean.ts";

type MemoryCleanRouteDeps = {
  bot(id: string): unknown;
  clean: {
    summary(botId: string): MemoryCleanSummary;
    undo(botId: string, runId: string): Promise<MemoryCleanUndoResult>;
  };
};

export function createMemoryCleanRoutes(deps: MemoryCleanRouteDeps) {
  return {
    get(res: ServerResponse, botId: string) {
      if (!deps.bot(botId)) return json(res, 404, { error: "no such bot" });
      return json(res, 200, deps.clean.summary(botId));
    },
    async undo(req: IncomingMessage, res: ServerResponse, botId: string) {
      if (!deps.bot(botId)) return json(res, 404, { error: "no such bot" });
      const parsed = z.object({ runId: z.string().min(1) }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "runId required" });
      const result = await deps.clean.undo(botId, parsed.data.runId);
      return json(res, result.ok ? 200 : result.error === "no-run" ? 404 : 409, result);
    },
  };
}
