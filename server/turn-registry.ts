export interface LiveTurn {
  botId: string;
  threadId: string;
  owner: "user" | "peer" | "room";
  depth: number;
  rootId: string | null;
  nowWatch: unknown[];
  docFix?: string;
}

type TurnStart = Omit<LiveTurn, "nowWatch" | "rootId"> & { rootId?: string | null };

export class TurnRegistry {
  private readonly turns = new Map<string, LiveTurn>();
  private readonly threads = new Map<string, string>();
  private readonly starting = new Map<string, Omit<LiveTurn, "nowWatch">>();

  prepare(turn: TurnStart): void {
    this.starting.set(turn.threadId, { ...turn, rootId: turn.rootId ?? null });
  }

  started(turnId: string, threadId: string): void {
    const turn = this.starting.get(threadId);
    if (turn) {
      this.starting.delete(threadId);
      this.start(turnId, turn);
    }
  }

  cancel(threadId: string): void {
    this.starting.delete(threadId);
  }

  start(turnId: string, turn: TurnStart): void {
    const previous = this.threads.get(turn.threadId);
    if (previous && previous !== turnId) this.turns.delete(previous);
    this.turns.set(turnId, { ...turn, rootId: turn.rootId ?? null, nowWatch: [] });
    this.threads.set(turn.threadId, turnId);
  }

  get(turnId: string): LiveTurn | undefined {
    return this.turns.get(turnId);
  }

  current(threadId: string): { turnId: string } & LiveTurn | undefined {
    const turnId = this.threads.get(threadId);
    const turn = turnId ? this.turns.get(turnId) : undefined;
    return turnId && turn ? { turnId, ...turn } : undefined;
  }

  adoptRoot(threadId: string, rootId: string): void {
    const starting = this.starting.get(threadId);
    if (starting) starting.rootId = rootId;
    const turnId = this.threads.get(threadId);
    const turn = turnId ? this.turns.get(turnId) : undefined;
    if (turn) turn.rootId = rootId;
  }

  settle(turnId: string): void {
    const turn = this.turns.get(turnId);
    if (turn && this.threads.get(turn.threadId) === turnId) this.threads.delete(turn.threadId);
    this.turns.delete(turnId);
  }
}

export const turnRegistry = new TurnRegistry();
