import type { AccountContext } from "./account-policy.ts";
import type { ProviderInstance } from "./contracts.ts";

export interface WorkerTurn {
  readonly threadId?: string;
  readonly instanceId: string;
  readonly driverKind: string;
  readonly account?: AccountContext;
}

export type WorkerTurnResolver = (botId: string) => WorkerTurn | undefined;

export function createWorkerTurns() {
  const turns = new Map<string, { botId: string; turn: WorkerTurn }>();
  const active = new Map<string, string>();
  return {
    capture(botId: string, threadId: string, instance: Pick<ProviderInstance, "instanceId" | "driverKind" | "account">) {
      const turn = Object.freeze({ threadId, instanceId: instance.instanceId, driverKind: instance.driverKind,
        ...(instance.account ? { account: Object.freeze({ ...instance.account }) } : {}),
      });
      turns.set(threadId, { botId, turn });
      active.set(botId, threadId);
    },
    resolveWorkerTurn(botId: string): WorkerTurn | undefined {
      const threadId = active.get(botId);
      return threadId ? turns.get(threadId)?.turn : undefined;
    },
    settled(threadId: string) {
      const entry = turns.get(threadId);
      if (entry && active.get(entry.botId) === threadId) active.delete(entry.botId);
      turns.delete(threadId);
    },
  };
}
