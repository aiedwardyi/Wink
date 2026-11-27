// Which provider sessions already hold which system text, for engines with no
// system slot: a resumed session that holds the exact text gets only the turn
// text. With an instance id the ledger lives on disk, so a restart does not
// re-send the whole system into a session that already holds it.
import { createHash } from "node:crypto";
import { dropSessionSystem, readSessionSystem, writeSessionSystem } from "../session-system.ts";
import { systemLinesReordered, withSystemChanges } from "../turn-context.ts";

export function systemLedger(keepText = false, instanceId?: string) {
  const held = new Map<string, { hash: string; text: string }>();
  const digest = (system: string) => createHash("sha256").update(system).digest("hex");
  const entry = (sessionId: string) => {
    const known = held.get(sessionId);
    if (known || instanceId === undefined) return known;
    const text = readSessionSystem(instanceId, sessionId);
    if (text === undefined) return undefined;
    const loaded = { hash: digest(text), text };
    held.set(sessionId, loaded);
    return loaded;
  };
  return {
    holds: (sessionId: string, system: string) => entry(sessionId)?.hash === digest(system),
    prompt: (sessionId: string | null, system: string | undefined) => {
      if (!system) return undefined;
      const previous = sessionId ? entry(sessionId) : undefined;
      if (!previous) return system;
      if (previous.hash === digest(system)) return undefined;
      if (!keepText) return system;
      if (systemLinesReordered(previous.text, system)) return system;
      const update = withSystemChanges("", previous.text, system);
      return update && update.length < system.length ? update : system;
    },
    /** A turn is running: a crash before settle may follow a compaction. */
    begin: (sessionId: string) => {
      if (instanceId === undefined) return;
      entry(sessionId);
      dropSessionSystem(instanceId, sessionId);
    },
    /** Only after the provider accepted a prompt carrying this text. */
    record: (sessionId: string, system: string) => {
      held.set(sessionId, { hash: digest(system), text: system });
      if (instanceId !== undefined) writeSessionSystem(instanceId, sessionId, system);
    },
    /** The turn settled without compaction: the session still holds what it held. */
    keep: (sessionId: string) => {
      const known = held.get(sessionId);
      if (known && instanceId !== undefined) writeSessionSystem(instanceId, sessionId, known.text);
    },
    forget: (sessionId: string) => {
      held.delete(sessionId);
      if (instanceId !== undefined) dropSessionSystem(instanceId, sessionId);
    },
  };
}
