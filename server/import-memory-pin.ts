// Every engine keys its warm process by the agents env, so a session keeps the import_memory tool it started
// with: dropping it on message 4 cold-starts the engine. Saving still ends on the per-turn rule (see open).
import type { SendTurnInput } from "./contracts.ts";

const MAX_PINS = 32;

type Cursor = SendTurnInput["resumeCursor"];
type Pin = { instanceId: string; cursor: Cursor; open: boolean };

const sameCursor = (a: Cursor, b: Cursor) => JSON.stringify(a) === JSON.stringify(b);

export function importMemoryPins(max = MAX_PINS) {
  const pins = new Map<string, Pin>();
  return {
    /** `cursor` is the session this turn resumes, undefined for a new one; `open` is the per-turn rule's answer. */
    forTurn(threadId: string, instanceId: string, cursor: Cursor, open: boolean): boolean {
      const pin = pins.get(threadId);
      pins.delete(threadId);
      // a pin from a session's first turn binds to the cursor that session got
      const held = cursor !== undefined && pin?.instanceId === instanceId && (pin.cursor === undefined || sameCursor(pin.cursor, cursor));
      if (!held && !open) return false;
      pins.set(threadId, { instanceId, cursor, open });
      if (pins.size > max) pins.delete(pins.keys().next().value!);
      return true;
    },
    /** Whether import_memory may save in this chat's current turn. */
    open: (threadId: string): boolean => pins.get(threadId)?.open === true,
  };
}
