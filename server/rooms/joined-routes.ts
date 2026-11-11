// /api/joined/: this PC's side of rooms it joined elsewhere. Local only (phone-auth
// LOCAL_ONLY_PREFIXES), so no relay caller reaches them; no reply carries the guest key.
import type { GuestClient, GuestResult } from "./guest-client.ts";

const ROOM = /^\/api\/joined\/rooms\/([\w-]{1,64})(?:\/(send|leave))?$/;

type Reply = { status: number; body: unknown };

const notFound: Reply = { status: 404, body: { error: "not found" } };

function reply<T>(result: GuestResult<T> & { sendId?: string }, key: string): Reply {
  if (result.ok) return { status: 200, body: { [key]: result.value, ...(result.sendId ? { sendId: result.sendId } : {}) } };
  return { status: result.status, body: { error: result.error, ...(result.sendId ? { sendId: result.sendId } : {}) } };
}

const field = (body: unknown, name: string): unknown =>
  body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>)[name] : undefined;

export async function joinedRoute(
  method: string, path: string, client: Pick<GuestClient, "start" | "rooms" | "room" | "join" | "send" | "leave">, body: () => Promise<unknown>,
): Promise<Reply | null> {
  if (!path.startsWith("/api/joined/")) return null;
  client.start();
  if (path === "/api/joined/rooms") return method === "GET" ? { status: 200, body: { rooms: client.rooms() } } : notFound;
  if (path === "/api/joined/join") {
    if (method !== "POST") return notFound;
    const code = field(await body(), "code");
    return typeof code === "string" ? reply(await client.join(code), "room") : { status: 400, body: { error: "bad-code" } };
  }
  const route = ROOM.exec(path);
  if (!route) return notFound;
  const [, roomId, action] = route as unknown as [string, string, "send" | "leave" | undefined];
  if (!action) {
    const room = method === "GET" ? client.room(roomId) : null;
    return room ? { status: 200, body: { room } } : notFound;
  }
  if (method !== "POST") return notFound;
  if (action === "leave") return reply(await client.leave(roomId), "room");
  const fields = await body();
  return reply(await client.send(roomId, field(fields, "text"), field(fields, "replyToId"), field(fields, "sendId"), field(fields, "fileIds")), "entry");
}
