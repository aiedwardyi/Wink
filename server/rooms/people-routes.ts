// The host's People actions in a people-only team room: Invite, which hands back
// the room's one code, and Remove, which also keeps that PC from rejoining with
// it. Local only (/api/rooms/), owner only.
import type { IncomingMessage, ServerResponse } from "node:http";

import { json } from "../http-helpers.ts";
import type { Store } from "../store.ts";
import { removeRoomPerson } from "./door.ts";
import { barRoomPerson, roomCode } from "./invites.ts";
import { peopleOnlyRoom } from "./people-only.ts";

const ROUTE = /^\/api\/rooms\/([\w-]{1,64})\/(?:invites|people\/([\w-]{1,64}))$/;

export interface PeopleRouteDeps {
  store: Pick<Store, "groups">;
  /** This PC's relay host, null while it has none. */
  relayHost: () => string | null;
  /** The caller holds a bot's comms token. */
  botCaller: boolean;
}

/** False when the path isn't ours. The code goes only into the reply body. */
export async function peopleRoute(_req: IncomingMessage, res: ServerResponse, method: string, path: string, deps: PeopleRouteDeps): Promise<boolean> {
  const route = ROUTE.exec(path);
  if (!route) return false;
  const [, roomId, personId] = route as unknown as [string, string, string | undefined];
  const served = peopleOnlyRoom(roomId) && deps.store.groups.some((group) => group.hosted?.roomId === roomId);
  if (!served || method !== (personId ? "DELETE" : "POST")) json(res, 404, { error: "not found" });
  else if (deps.botCaller) json(res, 403, { error: "forbidden" });
  else if (personId) {
    barRoomPerson(roomId, personId);
    if (removeRoomPerson(roomId, personId)) json(res, 200, { ok: true });
    else json(res, 404, { error: "not found" });
  } else {
    const relayHost = deps.relayHost();
    if (!relayHost) json(res, 409, { error: "phone access is off" });
    else {
      const code = roomCode(roomId);
      json(res, 200, { code: `wkr1:${relayHost}:${code.id}.${code.secret}` });
    }
  }
  return true;
}
