// A joined room's chat takes its owner's turns and read-only turns on other people's words alike.
// An owner's turn can read this PC's files into the engine's session, so a guest's turn that
// resumed that session could repeat them. A guest's turn resumes only a session that guests'
// turns alone built; otherwise it starts over from the chat's words, which the room already saw.
// In memory only: after a restart a guest's first turn starts over, the safe side.
export class GuestSessions {
  private readonly guestOnly = new Set<string>();

  /** A guest's read-only turn: true when the session it would resume may hold an owner's turn. */
  guestTurn(threadId: string): boolean {
    if (this.guestOnly.has(threadId)) return false;
    this.guestOnly.add(threadId);
    return true;
  }

  /** Any other turn: the session may hold this PC's files again. */
  ownerTurn(threadId: string): void {
    this.guestOnly.delete(threadId);
  }
}
