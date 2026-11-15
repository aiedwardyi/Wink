// Which provider sessions already hold which system text, for engines with no
// system slot: a resumed session that holds the exact text gets only the turn
// text. One ledger per driver instance, so a restart re-sends once.
import { createHash } from "node:crypto";
import { systemLinesReordered, withSystemChanges } from "../turn-context.ts";

export function systemLedger(keepText = false) {
  const held = new Map<string, { hash: string; text?: string }>();
  const digest = (system: string) => createHash("sha256").update(system).digest("hex");
  return {
    holds: (sessionId: string, system: string) => held.get(sessionId)?.hash === digest(system),
    prompt: (sessionId: string | null, system: string | undefined) => {
      if (!system) return undefined;
      const previous = sessionId ? held.get(sessionId) : undefined;
      if (!previous) return system;
      if (previous.hash === digest(system)) return undefined;
      if (previous.text === undefined) return system;
      if (systemLinesReordered(previous.text, system)) return system;
      const update = withSystemChanges("", previous.text, system);
      return update && update.length < system.length ? update : system;
    },
    /** Only after the provider accepted a prompt carrying this text. */
    record: (sessionId: string, system: string) => {
      held.set(sessionId, { hash: digest(system), ...(keepText ? { text: system } : {}) });
    },
    forget: (sessionId: string) => {
      held.delete(sessionId);
    },
  };
}
