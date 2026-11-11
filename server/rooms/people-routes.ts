// The host's People actions in a people-only team room: Invite, which hands the
// one-time code back once, and Remove. Local only (/api/rooms/), owner only.
import type { IncomingMessage, ServerResponse } from "node:http";

import { json, readBody } from "../http-helpers.ts";
import type { Store } from "../store.ts";
import { removeRoomPerson } from "./door.ts";
import { createInvite } from "./invites.ts";
import { peopleOnlyRoom } from "./people-only.ts";

const ROUTE = /^\/api\/rooms\/([\w-]{1,64})\/(?:invites|people\/([\w-]{1,64}))$/;

export interface PeopleRouteDeps {
  store: Pick<Store, "groups">;
  teamRooms: boolean;
  hostName: () => string;
  /** This PC's relay host, null while it has none. */
  relayHost: () => string | null;
  /** The caller holds a bot's comms token. */
  botCaller: boolean;
}

/** False when the path isn't ours. The code goes only into the reply body. */
export async function peopleRoute(req: IncomingMessage, res: ServerResponse, method: string, path: string, deps: PeopleRouteDeps): Promise<boolean> {
  const route = ROUTE.exec(path);
  if (!route) return false;
  const [, roomId, personId] = route as unknown as [string, string, string | undefined];
  const served = deps.teamRooms && peopleOnlyRoom(roomId) && deps.store.groups.some((group) => group.hosted?.roomId === roomId);
  if (!served || method !== (personId ? "DELETE" : "POST")) json(res, 404, { error: "not found" });
  else if (deps.botCaller) json(res, 403, { error: "forbidden" });
  else if (personId) {
    if (removeRoomPerson(roomId, personId)) json(res, 200, { ok: true });
    else json(res, 404, { error: "not found" });
  } else {
    const relayHost = deps.relayHost();
    if (!relayHost) {
      json(res, 409, { error: "phone access is off" });
      return true;
    }
    try {
      const { invite, secret } = createInvite(roomId, (await readBody(req))?.name, "chat", [deps.hostName()]);
      json(res, 200, { invite, code: `wkr1:${relayHost}:${invite.id}.${secret}` });
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === undefined) throw error;
      json(res, status, { error: (error as Error).message });
    }
  }
  return true;
}
