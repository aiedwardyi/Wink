// The host's People actions in a hosted team room: Invite, which hands back
// the room's one code; Remove, which also keeps that PC from rejoining with
// it; Let back in; Can make bots work; and taking out a teammate's bot. Local only (/api/rooms/): the host and their own bots.
import type { IncomingMessage, ServerResponse } from "node:http";

import { json, readBody } from "../http-helpers.ts";
import type { Store } from "../store.ts";
import { setPersonWorks } from "./db.ts";
import { removeRoomPerson, removeRoomTeamBot } from "./door.ts";
import { barRoomPerson, roomCode, shortRoomCode, unbarRoomPerson } from "./invites.ts";

const ROUTE = /^\/api\/rooms\/([\w-]{1,64})\/(?:invites|people\/([\w-]{1,64})\/(back|works)|people\/([\w-]{1,64})|bots\/([\w-]{1,64}))$/;

export interface PeopleRouteDeps {
  store: Pick<Store, "groups" | "emit">;
  /** This PC's relay host, null while it has none. */
  relayHost: () => string | null;
  /** A short code from the relay, null while it can't mint one. */
  mintRoomCode?(): Promise<{ code: string; exp: number } | null>;
}

/** False when the path isn't ours. The code goes only into the reply body. */
export async function peopleRoute(req: IncomingMessage, res: ServerResponse, method: string, path: string, deps: PeopleRouteDeps): Promise<boolean> {
  const route = ROUTE.exec(path);
  if (!route) return false;
  const [, roomId, actedOn, action, removed, botId] = route as unknown as [string, string, string | undefined, "back" | "works" | undefined, string | undefined, string | undefined];
  const personId = actedOn ?? removed;
  const back = action === "back";
  const group = deps.store.groups.find((candidate) => candidate.hosted?.roomId === roomId);
  if (!group || method !== (removed || botId ? "DELETE" : "POST")) json(res, 404, { error: "not found" });
  else if (action === "works") {
    const on = ((await readBody(req)) as { on?: unknown } | null)?.on;
    if (typeof on !== "boolean") json(res, 400, { error: "on must be true or false" });
    else if (setPersonWorks(roomId, personId!, on)) {
      deps.store.emit({ type: "group", groupId: group.id });
      json(res, 200, { ok: true });
    } else json(res, 404, { error: "not found" });
  } else if (botId) {
    if (removeRoomTeamBot(roomId, botId)) json(res, 200, { ok: true });
    else json(res, 404, { error: "not found" });
  } else if (personId && back) {
    if (unbarRoomPerson(roomId, personId)) {
      deps.store.emit({ type: "group", groupId: group.id });
      json(res, 200, { ok: true });
    } else json(res, 404, { error: "not found" });
  } else if (personId) {
    if (removeRoomPerson(roomId, personId)) {
      const barred = barRoomPerson(roomId, personId);
      // The frame removeRoomPerson sent predates the bar.
      deps.store.emit({ type: "group", groupId: group.id });
      json(res, 200, { ok: true, codeChanged: true, ...(barred ? { barred } : {}) });
    } else json(res, 404, { error: "not found" });
  } else {
    const relayHost = deps.relayHost();
    if (!relayHost) json(res, 409, { error: "phone access is off" });
    else {
      const code = roomCode(roomId);
      const short = deps.mintRoomCode ? await shortRoomCode(roomId, deps.mintRoomCode) : null;
      json(res, 200, { code: `wkr1:${relayHost}:${code.id}.${code.secret}`, ...(short ? { short } : {}) });
    }
  }
  return true;
}
