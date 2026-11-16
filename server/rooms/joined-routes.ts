// /api/joined/: this PC's side of rooms it joined elsewhere. Local only (phone-auth
// LOCAL_ONLY_PREFIXES), so no relay caller reaches them; no reply carries the guest key.
import type { GuestClient, GuestResult } from "./guest-client.ts";

const ROOM = /^\/api\/joined\/rooms\/([\w-]{1,64})(?:\/(send|leave|rejoin|read|notice|older|stop))?$/;
const REACT = /^\/api\/joined\/rooms\/([\w-]{1,64})\/entries\/([\w-]{1,64})\/reactions$/;
const BOTS = /^\/api\/joined\/rooms\/([\w-]{1,64})\/bots(?:\/([\w-]{1,64}))?$/;

type Reply = { status: number; body: unknown };

const notFound: Reply = { status: 404, body: { error: "not found" } };

function reply<T>(result: GuestResult<T> & { sendId?: string }, key: string): Reply {
  if (result.ok) return { status: 200, body: { [key]: result.value, ...(result.sendId ? { sendId: result.sendId } : {}) } };
  return { status: result.status, body: { error: result.error, ...(result.sendId ? { sendId: result.sendId } : {}), ...(result.groupId ? { groupId: result.groupId } : {}) } };
}

const field = (body: unknown, name: string): unknown =>
  body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>)[name] : undefined;

export async function joinedRoute(
  method: string, path: string, client: Pick<GuestClient, "start" | "rooms" | "room" | "join" | "send" | "leave" | "rejoin" | "remove" | "read" | "react" | "notice" | "older" | "addBot" | "removeBot">, body: () => Promise<unknown>,
  query = new URLSearchParams(),
  localBot: (botId: string) => { id: string; name: string; color: string } | null = () => null,
  stopMine: (roomId: string) => Promise<void> = async () => {},
): Promise<Reply | null> {
  if (!path.startsWith("/api/joined/")) return null;
  client.start();
  if (path === "/api/joined/rooms") return method === "GET" ? { status: 200, body: { rooms: client.rooms() } } : notFound;
  if (path === "/api/joined/join") {
    if (method !== "POST") return notFound;
    const code = field(await body(), "code");
    return typeof code === "string" ? reply(await client.join(code), "room") : { status: 400, body: { error: "bad-code" } };
  }
  const reaction = REACT.exec(path);
  if (reaction) return method === "POST" ? reply(await client.react(reaction[1]!, reaction[2], field(await body(), "emoji")), "marks") : notFound;
  const bots = BOTS.exec(path);
  if (bots) {
    if (bots[2]) return method === "DELETE" ? reply(await client.removeBot(bots[1]!, bots[2]), "removed") : notFound;
    if (method !== "POST") return notFound;
    const botId = field(await body(), "botId");
    const bot = typeof botId === "string" ? localBot(botId) : null;
    return bot ? reply(await client.addBot(bots[1]!, bot.id, bot.name, bot.color), "bot") : { status: 404, body: { error: "no such bot" } };
  }
  const route = ROOM.exec(path);
  if (!route) return notFound;
  const [, roomId, action] = route as unknown as [string, string, "send" | "leave" | "rejoin" | "read" | "notice" | "older" | "stop" | undefined];
  if (!action) {
    if (method === "DELETE") return reply(await client.remove(roomId), "removed");
    const room = method === "GET" ? client.room(roomId, Number(query.get("limit")) || undefined) : null;
    return room ? { status: 200, body: { room } } : notFound;
  }
  if (method !== "POST") return notFound;
  if (action === "stop") {
    await stopMine(roomId);
    return { status: 200, body: { ok: true } };
  }
  if (action === "leave") return reply(await client.leave(roomId), "room");
  if (action === "rejoin") return reply(await client.rejoin(roomId, field(await body(), "code")), "room");
  const fields = await body();
  if (action === "read") return reply(client.read(roomId, field(fields, "seq")), "room");
  if (action === "older") return reply(await client.older(roomId, field(fields, "before")), "more");
  if (action === "notice") return reply(await client.notice(roomId, field(fields, "entryId") ?? null), "result");
  return reply(await client.send(roomId, field(fields, "text"), field(fields, "replyToId"), field(fields, "sendId"), field(fields, "fileIds")), "entry");
}
