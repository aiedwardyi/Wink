// The host's People actions in a hosted team room: Invite, which hands back
// the room's one code; Remove, which also keeps that PC from rejoining with
// it; Let back in; and taking out a teammate's bot. Local only (/api/rooms/), owner only.
import type { IncomingMessage, ServerResponse } from "node:http";

import { json } from "../http-helpers.ts";
import type { Store } from "../store.ts";
import { removeRoomPerson, removeRoomTeamBot } from "./door.ts";
import { barRoomPerson, roomCode, shortRoomCode, unbarRoomPerson } from "./invites.ts";

const ROUTE = /^\/api\/rooms\/([\w-]{1,64})\/(?:invites|people\/([\w-]{1,64})(\/back)?|bots\/([\w-]{1,64}))$/;

export interface PeopleRouteDeps {
  store: Pick<Store, "groups" | "emit">;
  /** This PC's relay host, null while it has none. */
  relayHost: () => string | null;
  /** The caller holds a bot's comms token. */
  botCaller: boolean;
  /** A short code from the relay, null while it can't mint one. */
  mintRoomCode?(): Promise<{ code: string; exp: number } | null>;
}

/** False when the path isn't ours. The code goes only into the reply body. */
export async function peopleRoute(_req: IncomingMessage, res: ServerResponse, method: string, path: string, deps: PeopleRouteDeps): Promise<boolean> {
  const route = ROUTE.exec(path);
  if (!route) return false;
  const [, roomId, personId, back, botId] = route as unknown as [string, string, string | undefined, string | undefined, string | undefined];
  const group = deps.store.groups.find((candidate) => candidate.hosted?.roomId === roomId);
  if (!group || method !== ((personId && !back) || botId ? "DELETE" : "POST")) json(res, 404, { error: "not found" });
  else if (deps.botCaller) json(res, 403, { error: "forbidden" });
  else if (botId) {
    if (removeRoomTeamBot(roomId, botId)) json(res, 200, { ok: true });
    else json(res, 404, { error: "not found" });
  } else if (personId && back) {
    if (unbarRoomPerson(roomId, personId)) {
      deps.store.emit({ type: "group", groupId: group.id });
      json(res, 200, { ok: true });
    } else json(res, 404, { error: "not found" });
  } else if (personId) {
    if (removeRoomPerson(roomId, personId)) {
      const codeChanged = barRoomPerson(roomId, personId);
      // The frame removeRoomPerson sent predates the bar.
      deps.store.emit({ type: "group", groupId: group.id });
      json(res, 200, { ok: true, ...(codeChanged ? { codeChanged } : {}) });
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
