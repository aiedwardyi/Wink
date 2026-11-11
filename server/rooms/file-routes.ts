// Room files over HTTP: the door's file actions for guests, and /api/rooms/ for
// the host (local only). Callers do the ACL; ids resolve only inside one room.
import type { IncomingMessage, ServerResponse } from "node:http";

import { json, readBody } from "../http-helpers.ts";
import type { Store } from "../store.ts";
import type { HostedGroup } from "./asks.ts";
import { committedRoomText, roomEntry } from "./db.ts";
import { doorEntry } from "./door-streams.ts";
import { MAX_MESSAGE_FILES, saveRoomFile, serveRoomFile } from "./files.ts";
import { peopleOnlyRoom } from "./people-only.ts";
import { hostedSend } from "./send.ts";

export type FileAction = "upload" | "download" | "preview";

/** `/rooms/:roomId/files`, `.../files/:fileId`, `.../files/:fileId/preview`. */
export const FILE_PATH = /^\/rooms\/([\w-]{1,64})\/files(?:\/([A-Za-z0-9_-]{24})(\/preview)?)?$/;

export const fileAction = (match: RegExpExecArray): FileAction => (match[3] ? "preview" : match[2] ? "download" : "upload");

function reply(res: ServerResponse, status: number, body: unknown, close = false): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...(close ? { connection: "close" } : {}) });
  res.end(JSON.stringify(body));
}

/** Upload, download or preview for one room member: "host" or a person id. `match` is FILE_PATH's. */
export async function fileRoute(match: RegExpExecArray, req: IncomingMessage, res: ServerResponse, url: URL, roomId: string, owner: string, still?: () => boolean): Promise<void> {
  const action = fileAction(match);
  if (action !== "upload") {
    if (!(await serveRoomFile(res, roomId, match[2]!, action === "preview"))) reply(res, 404, { error: "not found" });
    return;
  }
  try {
    const file = await saveRoomFile(req, roomId, { owner, name: url.searchParams.get("name"), uploadId: url.searchParams.get("uploadId"), still });
    reply(res, 200, { file });
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === undefined) throw error;
    // The rest of a refused body may still be on its way.
    reply(res, status, { error: (error as Error).message }, !req.readableEnded);
  }
}

export const sameFiles = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, at) => id === b[at]);

export const fileIdsOf = (value: unknown): string[] | null =>
  value === undefined ? [] : Array.isArray(value) && value.length <= MAX_MESSAGE_FILES && value.every((id) => typeof id === "string") ? value : null;

const SEND_ID = /^[A-Za-z0-9_-]{16,80}$/;
const HOST_ROUTE = /^\/api\/rooms\/([\w-]{1,64})\/(send|files(?:\/[A-Za-z0-9_-]{24}(?:\/preview)?)?)$/;

/** The host's side: upload, download, preview, and a send that carries files. False when the path isn't ours. */
export async function hostFileRoute(
  req: IncomingMessage, res: ServerResponse, method: string, url: URL, deps: { store: Pick<Store, "groups" | "messagesFor"> },
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/rooms/")) return false;
  const route = HOST_ROUTE.exec(url.pathname);
  const roomId = route?.[1];
  const group = roomId && peopleOnlyRoom(roomId) ? deps.store.groups.find((candidate) => candidate.hosted?.roomId === roomId) : undefined;
  const file = route?.[2] === "send" ? null : FILE_PATH.exec(url.pathname.slice("/api".length));
  const action = file ? fileAction(file) : "send";
  if (!route || !group || method !== (action === "upload" || action === "send" ? "POST" : "GET")) {
    reply(res, 404, { error: "not found" });
    return true;
  }
  if (file) {
    await fileRoute(file, req, res, url, roomId!, "host");
    return true;
  }
  try {
    const body = await readBody(req);
    const text = body?.text ?? "";
    const replyToId = body?.replyToId;
    const sendId = body?.sendId;
    const fileIds = fileIdsOf(body?.fileIds);
    if (typeof text !== "string" || !fileIds || (replyToId !== undefined && typeof replyToId !== "string") || (sendId !== undefined && (typeof sendId !== "string" || !SEND_ID.test(sendId)))) {
      json(res, 400, { error: "bad request" });
      return true;
    }
    const earlier = sendId ? deps.store.messagesFor(group.threadId).find((message) => message.sendId === sendId && message.author?.kind === "host") : undefined;
    const entry = earlier?.roomEntryId ? roomEntry(roomId!, earlier.roomEntryId) : null;
    if (earlier && (!entry || entry.text !== committedRoomText("host", text) || entry.replyToId !== replyToId || !sameFiles((entry.files ?? []).map((f) => f.id), fileIds))) {
      json(res, 409, { error: "sendId was used for another message" });
    } else {
      json(res, 200, { entry: doorEntry(entry ?? hostedSend(group as HostedGroup, { kind: "host" }, text, replyToId, sendId, fileIds).entry) });
    }
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === undefined) throw error;
    json(res, status, { error: (error as Error).message });
  }
  return true;
}
