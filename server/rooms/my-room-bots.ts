// This PC's own bots in rooms it joined. Only this PC's person wakes one, by
// @name or a reply to its line; it works here in one hidden task per room and
// its answer goes back through the door under its room name.
import { roomResponder } from "../../shared/room-routing.ts";
import type { Message } from "../store.ts";
import type { GuestClient } from "./guest-client.ts";
import { joinedEntries, joinedEntry, joinedRoom, myRoomBots, setMyRoomBotTurn, type JoinedEntry, type JoinedFile, type MyRoomBot } from "./joined.ts";
import { WINDOW_CHARS, WINDOW_ENTRIES } from "./windows.ts";

export type MyBotTurn = { working?: boolean; error?: "busy" | "failed" };

export interface MyRoomBotDeps {
  client: Pick<GuestClient, "botSend" | "file">;
  bot(botId: string): { id: string; name: string } | null;
  /** The bot's task thread still exists. */
  hasTask(botId: string, threadId: string): boolean;
  createTask(botId: string, title: string): { threadId: string } | null;
  /** `prompt` goes to the model; `typed` is the task's user row. */
  startTurn(botId: string, threadId: string, prompt: string, typed: string): Promise<unknown>;
  messagesFor(threadId: string): Message[];
  changed(roomId: string): void;
}

type Running = { roomId: string; id: string; entry: JoinedEntry; since: number };

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
    if (!room || !state?.teamBots || entry.author.kind !== "person" || entry.author.id !== room.me.id) return;
    const mine = new Map(myRoomBots(roomId).map((bot) => [bot.id, bot]));
    const own = state.teamBots.filter((bot) => bot.owner === room.me.id && mine.has(bot.id));
    if (!own.length) return;
    const others = state.teamBots.filter((bot) => !own.includes(bot)).map((bot) => bot.name);
    const quote = entry.replyToId ? joinedEntry(roomId, entry.replyToId) : null;
    const hit = roomResponder(entry.text, [...state.bots, ...own], [state.host, ...state.people.map((person) => person.name), ...others], quote?.author.kind === "bot" ? quote.author.id : undefined, false);
    const bot = hit && mine.get(hit.id);
    if (bot) void this.run(roomId, bot, hit.name, entry, quote);
  }

  private set(roomId: string, id: string, turn: MyBotTurn | undefined): void {
    const key = `${roomId}\n${id}`;
    if (turn) this.turns.set(key, turn);
    else this.turns.delete(key);
    this.deps.changed(roomId);
  }

  private async run(roomId: string, bot: MyRoomBot, roomName: string, entry: JoinedEntry, quote: JoinedEntry | null): Promise<void> {
    const local = this.deps.bot(bot.botId);
    const room = joinedRoom(roomId);
    if (!local || !room?.state) return this.set(roomId, bot.id, { error: "failed" });
    this.set(roomId, bot.id, { working: true });
    try {
      let threadId = bot.threadId && this.deps.hasTask(local.id, bot.threadId) ? bot.threadId : null;
      if (!threadId) {
        threadId = this.deps.createTask(local.id, room.state.roomName)?.threadId ?? null;
        if (!threadId) return this.set(roomId, bot.id, { error: "failed" });
        setMyRoomBotTurn(roomId, bot.id, threadId, 0);
      }
      const files = await this.files(roomId, [...(entry.files ?? []), ...(quote?.files ?? [])]);
      const window = since(roomId, bot.seenSeq, entry.seq);
      const prompt = [
        `(You are in the team room ${JSON.stringify(room.state.roomName)} on ${JSON.stringify(room.state.host)}'s Wink, as ${JSON.stringify(roomName)}. Your answer is posted there for everyone in the room. Only ${JSON.stringify(room.me.name)}, who runs you, can ask you.)`,
        ...(window.length ? ["Room lines since your last answer:", ...window.map(lineOf)] : []),
        ...(quote ? [`They replied to: ${lineOf(quote)}`] : []),
        ...(files.length ? ["Files on these lines, saved on this PC:", ...files] : []),
        `${JSON.stringify(room.me.name)} asked you: ${entry.text}`,
      ].join("\n");
      this.running.set(threadId, { roomId, id: bot.id, entry, since: this.deps.messagesFor(threadId).length });
      await this.deps.startTurn(local.id, threadId, prompt, entry.text);
    } catch (error) {
      for (const [threadId, run] of this.running) if (run.entry === entry) this.running.delete(threadId);
      this.set(roomId, bot.id, { error: (error as { code?: unknown } | null)?.code === "BOT_BUSY" ? "busy" : "failed" });
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
    if (!run) return;
    this.running.delete(threadId);
    const text = this.deps.messagesFor(threadId).slice(run.since).filter(shown).map((message) => message.text!.trim()).join("\n\n");
    if (!text) return this.set(run.roomId, run.id, ok ? undefined : { error: "failed" });
    const posted = await this.deps.client.botSend(run.roomId, run.id, text, run.entry.id);
    setMyRoomBotTurn(run.roomId, run.id, threadId, posted.ok ? posted.value.seq : run.entry.seq);
    this.set(run.roomId, run.id, posted.ok ? undefined : { error: "failed" });
  }
}
