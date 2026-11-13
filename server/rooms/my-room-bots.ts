// This PC's own bots in rooms it joined. This PC's person wakes one by @name
// or a reply to its line, and a room bot by @name; it works here in one hidden
// task per room and its answer goes back through the door under its room name.
import { botLineResponder, roomResponder } from "../../shared/room-routing.ts";
import type { Message } from "../store.ts";
import type { GuestClient } from "./guest-client.ts";
import { joinedEntries, joinedEntry, joinedRoom, myRoomBots, setMyRoomBotTurn, type JoinedEntry, type JoinedFile, type MyRoomBot } from "./joined.ts";
import { WINDOW_CHARS, WINDOW_ENTRIES } from "./windows.ts";

export type MyBotTurn = { working?: boolean; since?: number; waiting?: boolean; error?: "failed" };

export interface MyRoomBotDeps {
  client: Pick<GuestClient, "botSend" | "file">;
  bot(botId: string): { id: string; name: string } | null;
  busy(botId: string): boolean;
  /** The bot's task thread still exists. */
  hasTask(botId: string, threadId: string): boolean;
  createTask(botId: string, title: string): { threadId: string } | null;
  /** `prompt` goes to the model; `typed` is the task's user row. */
  startTurn(botId: string, threadId: string, prompt: string, typed: string, failed: () => void): Promise<unknown>;
  messagesFor(threadId: string): Message[];
  changed(roomId: string): void;
  interrupt(botId: string, threadId: string): Promise<void>;
}

type Waiting = { roomId: string; id: string; botId: string; after: number; entry: JoinedEntry };
type Running = Waiting & { since: number };

const DAY = 24 * 60 * 60 * 1000;

const lineOf = (entry: JoinedEntry) => `${entry.author.name}: ${entry.text}`;

const shown = (message: Message) =>
  message.role === "bot" && message.kind === "text" && !message.summarized && !message.queued && !message.quick && !message.comm && Boolean(message.text?.trim());

/** Lines since the bot's last turn, newest kept, under the room window's caps. */
function since(roomId: string, after: number, before: number): JoinedEntry[] {
  const out: JoinedEntry[] = [];
  let chars = 0;
  for (const entry of joinedEntries(roomId, WINDOW_ENTRIES + 1).reverse()) {
    if (entry.seq <= after || out.length >= WINDOW_ENTRIES) break;
    if (entry.seq >= before) continue;
    chars += entry.text.length;
    if (chars > WINDOW_CHARS) break;
    out.unshift(entry);
  }
  return out;
}

export class MyRoomBotTurns {
  private readonly turns = new Map<string, MyBotTurn>();
  private readonly running = new Map<string, Running>();
  private readonly waiting: Waiting[] = [];
  private readonly active = new Map<string, Waiting>();
  /** Head seq at the host's last Stop, per room. */
  private readonly stops = new Map<string, number>();
  /** Room task threads the owner stopped; they settle without a failure row. */
  private readonly stopped = new Set<string>();
  /** Turns the owner stopped while their files were still downloading. */
  private readonly cancelled = new Set<Waiting>();
  private readonly deps: MyRoomBotDeps;

  constructor(deps: MyRoomBotDeps) {
    this.deps = deps;
  }

  turn(roomId: string, id: string): MyBotTurn | undefined {
    return this.turns.get(`${roomId}\n${id}`);
  }

  /** Runs after the door stored this PC's line; never on its send path. */
  sent(roomId: string, entry: JoinedEntry): void {
    const room = joinedRoom(roomId);
    const state = room?.state;
    if (room?.status !== "joined" || !state?.teamBots || entry.author.kind !== "person" || entry.author.id !== room.me.id) return;
    const mine = new Map(myRoomBots(roomId).map((bot) => [bot.id, bot]));
    const own = state.teamBots.filter((bot) => bot.owner === room.me.id && mine.has(bot.id));
    if (!own.length) return;
    const others = state.teamBots.filter((bot) => !own.includes(bot)).map((bot) => bot.name);
    const quote = entry.replyToId ? joinedEntry(roomId, entry.replyToId) : null;
    const hit = roomResponder(entry.text, [...state.bots, ...own], [state.host, ...state.people.map((person) => person.name), ...others], quote?.author.kind === "bot" ? quote.author.id : undefined, false);
    this.queue(roomId, hit && mine.get(hit.id), entry);
  }

  /** A bot's line wakes the bot it @'s when that bot is this PC's. */
  heard(roomId: string, entry: JoinedEntry): void {
    const room = joinedRoom(roomId);
    const state = room?.state;
    if (room?.status !== "joined" || !state?.teamBots || entry.author.kind !== "bot" || Date.now() - entry.at > DAY || this.halted(roomId, entry.seq)) return;
    const hit = botLineResponder(entry.text, [...state.bots, ...state.teamBots], [state.host, ...state.people.map((person) => person.name)], entry.author.id);
    const own = hit && state.teamBots.some((bot) => bot.id === hit.id && bot.owner === room.me.id);
    this.queue(roomId, own ? myRoomBots(roomId).find((bot) => bot.id === hit.id) : undefined, entry);
  }

  /** Room Stop: bot lines wake no bot here until a person or the host speaks. */
  stop(roomId: string): void {
    this.stops.set(roomId, joinedEntries(roomId, 1)[0]?.seq ?? 0);
    this.drain();
  }

  /** The owner's Stop: this PC's asks in the room end here; the host's bots are never touched. */
  async stopMine(roomId: string): Promise<void> {
    for (const row of this.waiting.filter((each) => each.roomId === roomId)) {
      this.waiting.splice(this.waiting.indexOf(row), 1);
      this.set(roomId, row.id, undefined);
    }
    this.stop(roomId);
    for (const row of this.active.values()) {
      if (row.roomId === roomId && ![...this.running.values()].some((run) => run.botId === row.botId)) this.cancelled.add(row);
    }
    for (const [threadId, run] of this.running) {
      if (run.roomId !== roomId) continue;
      this.stopped.add(threadId);
      await this.deps.interrupt(run.botId, threadId);
    }
  }

  private halted(roomId: string, seq: number): boolean {
    const stop = this.stops.get(roomId);
    if (stop === undefined) return false;
    if (!joinedEntries(roomId, Math.max(seq - stop - 1, 0), seq).some((entry) => entry.author.kind !== "bot")) return true;
    this.stops.delete(roomId);
    return false;
  }

  private queue(roomId: string, bot: MyRoomBot | null | undefined, entry: JoinedEntry): void {
    if (!bot || entry.seq <= bot.seenSeq || this.waiting.some((row) => row.roomId === roomId && row.entry.id === entry.id) || [...this.active.values()].some((row) => row.roomId === roomId && row.entry.id === entry.id)) return;
    this.waiting.push({ roomId, id: bot.id, botId: bot.botId, after: bot.seenSeq, entry });
    this.drain();
  }

  drain(): void {
    for (const row of [...this.waiting]) {
      const room = joinedRoom(row.roomId);
      const bot = myRoomBots(row.roomId).find((candidate) => candidate.id === row.id && candidate.botId === row.botId);
      const listed = room?.state?.teamBots?.find((candidate) => candidate.id === row.id && candidate.owner === room.me.id);
      const asker = row.entry.author.kind === "bot" ? !this.halted(row.roomId, row.entry.seq) : row.entry.author.id === room?.me.id;
      if (room?.status !== "joined" || !asker || !bot || !listed || !this.deps.bot(row.botId)) {
        this.waiting.splice(this.waiting.indexOf(row), 1);
        this.set(row.roomId, row.id, undefined);
        continue;
      }
      if (this.active.has(row.botId) || this.deps.busy(row.botId)) {
        if (!this.turn(row.roomId, row.id)?.working) this.set(row.roomId, row.id, { waiting: true });
        continue;
      }
      this.waiting.splice(this.waiting.indexOf(row), 1);
      this.active.set(row.botId, row);
      void this.run(row, bot, listed.name);
    }
  }

  private set(roomId: string, id: string, turn: MyBotTurn | undefined): void {
    const key = `${roomId}\n${id}`;
    if (turn) this.turns.set(key, turn);
    else this.turns.delete(key);
    this.deps.changed(roomId);
  }

  private async run(row: Waiting, bot: MyRoomBot, roomName: string): Promise<void> {
    const { roomId, entry } = row;
    const quote = entry.replyToId ? joinedEntry(roomId, entry.replyToId) : null;
    const local = this.deps.bot(bot.botId);
    const room = joinedRoom(roomId);
    if (!local || !room?.state) {
      this.active.delete(bot.botId);
      return this.set(roomId, bot.id, { error: "failed" });
    }
    this.set(roomId, bot.id, { working: true, since: Date.now() });
    let mine: Running | undefined;
    try {
      let threadId = bot.threadId && this.deps.hasTask(local.id, bot.threadId) ? bot.threadId : null;
      if (!threadId) {
        threadId = this.deps.createTask(local.id, room.state.roomName)?.threadId ?? null;
        if (!threadId) throw new Error("couldn't create the room task");
        setMyRoomBotTurn(roomId, bot.id, threadId, 0);
      }
      const files = await this.files(roomId, [...(entry.files ?? []), ...(quote?.files ?? [])]);
      if (this.cancelled.delete(row)) {
        this.active.delete(bot.botId);
        this.set(roomId, bot.id, undefined);
        return queueMicrotask(() => this.drain());
      }
      const window = since(roomId, row.after, entry.seq);
      const { state } = room;
      const ownerOf = (owner?: string) => (owner ? state.people.find((person) => person.id === owner)?.name : state.host);
      const others = [
        ...state.bots.map((other) => [other.name, state.host] as const),
        ...(state.teamBots ?? []).filter((other) => other.id !== bot.id).map((other) => [other.name, ownerOf(other.owner)] as const),
      ].flatMap(([name, owner]) => (owner ? [`${JSON.stringify(name)} (${JSON.stringify(owner)})`] : []));
      const me = JSON.stringify(room.me.name);
      const owner = entry.author.kind === "bot" ? ownerOf(entry.author.owner) : undefined;
      const asker = entry.author.kind !== "bot" ? me : `${JSON.stringify(entry.author.name)}${owner ? ` (${JSON.stringify(owner)}'s bot)` : ""}`;
      const prompt = [
        `(You are in the team room ${JSON.stringify(state.roomName)} on ${JSON.stringify(state.host)}'s Wink, as ${JSON.stringify(roomName)}. Your answer is posted there for everyone in the room. ${others.length
          ? `${me}, who runs you, and this room's bots can ask you. Bots here: ${others.join(", ")}. @ another bot only to hand it real work, never just to thank or confirm; when the job is done, say so and tag no bot.`
          : `Only ${me}, who runs you, can ask you.`})`,
        ...(window.length ? ["Room lines since your last answer:", ...window.map(lineOf)] : []),
        ...(quote ? [`They replied to: ${lineOf(quote)}`] : []),
        ...(files.length ? ["Files on these lines, saved on this PC:", ...files] : []),
        `${asker} asked you: ${entry.text}`,
      ].join("\n");
      this.running.set(threadId, (mine = { ...row, since: this.deps.messagesFor(threadId).length }));
      await this.deps.startTurn(local.id, threadId, prompt, entry.text, () => {
        if (this.running.get(threadId) === mine) void this.settled(threadId, false);
      });
    } catch (error) {
      if (this.active.get(bot.botId) !== row) return;
      for (const [threadId, run] of this.running) if (run === mine) this.running.delete(threadId);
      this.active.delete(bot.botId);
      if ((error as { code?: unknown } | null)?.code === "BOT_BUSY") {
        this.waiting.unshift(row);
        return this.set(roomId, bot.id, { waiting: true });
      }
      this.set(roomId, bot.id, { error: "failed" });
      queueMicrotask(() => this.drain());
    }
  }

  private async files(roomId: string, files: readonly JoinedFile[]): Promise<string[]> {
    const out: string[] = [];
    for (const file of files) {
      if (file.deleted) continue;
      const got = await this.deps.client.file(roomId, file.id);
      out.push(got.ok ? `${file.name}: ${got.value.path}` : `${file.name}: (could not download)`);
    }
    return out;
  }

  /** Call on every settled turn; only a room task's posts. */
  async settled(threadId: string, ok: boolean): Promise<void> {
    const run = this.running.get(threadId);
    if (!run) return this.drain();
    this.running.delete(threadId);
    const stopped = this.stopped.delete(threadId);
    try {
      const text = this.deps.messagesFor(threadId).slice(run.since).filter(shown).map((message) => message.text!.trim()).join("\n\n");
      if (!text) return this.set(run.roomId, run.id, ok || stopped ? undefined : { error: "failed" });
      const posted = await this.deps.client.botSend(run.roomId, run.id, text, run.entry.id);
      setMyRoomBotTurn(run.roomId, run.id, threadId, posted.ok ? posted.value.seq : run.entry.seq);
      this.set(run.roomId, run.id, posted.ok ? undefined : { error: "failed" });
    } catch {
      this.set(run.roomId, run.id, { error: "failed" });
    } finally {
      this.active.delete(run.botId);
      this.drain();
    }
  }
}
