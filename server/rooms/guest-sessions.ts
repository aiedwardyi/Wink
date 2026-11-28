import type { ResumeSeed } from "../turn-context.ts";

// A joined room's chat takes its owner's turns and read-only turns on other people's words alike.
// An owner's turn can read this PC's files into the engine's session, so a guest's turn that
// resumed that session could repeat them. A guest's turn resumes only a session that guests'
// turns alone built; otherwise it starts over from the chat's words, which the room already saw.
// In memory only: after a restart a guest's first turn starts over, the safe side.
export class GuestSessions {
  // the cursor an owner's turn left when guests took over: still the owner's until a guest's session replaces it
  private readonly owned = new Map<string, { instanceId: string; cursor: string }>();

  /** A guest's read-only turn: true when the session it would resume may hold an owner's turn. */
  guestTurn(threadId: string, instanceId: string, cursor: ResumeSeed["cursor"]): boolean {
    const key = JSON.stringify(cursor ?? null);
    const owned = this.owned.get(threadId);
    if (owned?.instanceId === instanceId && owned.cursor !== key) return false;
    this.owned.set(threadId, { instanceId, cursor: key });
    return true;
  }

  /** Any other turn: the session may hold this PC's files again. */
  ownerTurn(threadId: string): void {
    this.owned.delete(threadId);
  }
}
