import { classifyChatError, quietUsageError } from "../shared/chat-error.ts";
import { ERROR_SITES } from "../shared/error-report.mjs";
import type { RuntimeEvent } from "./contracts.ts";
import { reportServerFailure } from "./error-reports.ts";
import type { TerminalBridgeAccess } from "./terminal-snapshot.ts";

export function writeChatError(line: string, access: TerminalBridgeAccess | null): boolean {
  const error = classifyChatError(line);
  if (error.kind !== "quiet") return true;
  console.warn(`chat: ${line}`);
  void reportServerFailure(access, ERROR_SITES[error.site]);
  return false;
}

/** accountId only for a sign-in error on an added account: the card then names that account, not the bot's engine. */
export function runtimeErrorTool(event: Extract<RuntimeEvent, { type: "runtime.error" }>, isAccount: (id: string) => boolean) {
  const { providerInstanceId } = event;
  return {
    name: `error: ${event.message}`,
    ok: false,
    setup: event.setup,
    usageLimit: event.usageLimit,
    signIn: event.signIn,
    accountId: event.signIn && providerInstanceId && isAccount(providerInstanceId) ? providerInstanceId : undefined,
    folder: event.folder,
  };
}

export function usageError(line: string | undefined, access: TerminalBridgeAccess | null): string | undefined {
  if (!line || !quietUsageError(line)) return line;
  console.warn(`usage: ${line}`);
  void reportServerFailure(access, ERROR_SITES.usageRefresh);
  return undefined;
}

export async function startQueuedTurn<T>(run: () => Promise<T>, cancelled: () => boolean, access: TerminalBridgeAccess | null): Promise<T | undefined> {
  let reported = false;
  while (!cancelled()) {
    try {
      return await run();
    } catch (cause) {
      const line = cause instanceof Error ? cause.message : String(cause);
      if (!/^(?:the bot is (?:already working|still stopping its last turn)|a turn is already running on this thread)/.test(line)) throw cause;
      if (!reported) writeChatError(`queued message could not start - ${line}`, access);
      reported = true;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}
