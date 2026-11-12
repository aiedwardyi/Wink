// Room files over HTTP: the door's file actions for guests, and /api/rooms/ for
// the host (local only). Callers do the ACL; ids resolve only inside one room.
import type { IncomingMessage, ServerResponse } from "node:http";

import { json, readBody } from "../http-helpers.ts";
import { isRelayRequest } from "../phone-relay/via.ts";
import type { Store } from "../store.ts";
import type { HostedGroup } from "./asks.ts";
import { committedRoomText, roomEntry } from "./db.ts";
import { broadcastDoorDeleted, doorEntry } from "./door-streams.ts";
import { deletedRoomFiles, deleteRoomFile, listRoomFiles, MAX_MESSAGE_FILES, roomFilesState, saveRoomFile, serveRoomFile } from "./files.ts";
import { moveRoomFiles, roomFilesFolder } from "./files-folder.ts";
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
    try {
      if (!(await serveRoomFile(res, roomId, match[2]!, action === "preview"))) reply(res, 404, { error: "not found" });
    } catch { reply(res, 503, { error: "room files folder is unavailable" }); }
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
  req: IncomingMessage, res: ServerResponse, method: string, url: URL, deps: { store: Pick<Store, "groups" | "messagesFor" | "patchMessage" | "patchGroup">; hostName?: () => string; botCaller: boolean },
): Promise<boolean> {
  if (url.pathname === "/api/room-files-folder") {
    if (isRelayRequest(req) || deps.botCaller) reply(res, 403, { error: "forbidden" });
    else {
      try {
        if (method === "GET") reply(res, 200, roomFilesFolder());
        else if (method === "PUT") reply(res, 200, await moveRoomFiles((await readBody(req))?.path));
        else reply(res, 404, { error: "not found" });
      } catch { reply(res, 503, { error: "room files folder is unavailable" }); }
    }
    return true;
  }
  if (!url.pathname.startsWith("/api/rooms/")) return false;
  const state = /^\/api\/rooms\/([\w-]{1,64})\/files-state$/.exec(url.pathname);
  if (state) {
    if (method !== "GET" || !deps.store.groups.some((group) => group.hosted?.roomId === state[1])) reply(res, 404, { error: "not found" });
    else if (deps.botCaller) reply(res, 403, { error: "forbidden" });
    else reply(res, 200, roomFilesState(state[1]!));
    return true;
  }
  const route = HOST_ROUTE.exec(url.pathname);
  const roomId = route?.[1];
  const group = roomId ? deps.store.groups.find((candidate) => candidate.hosted?.roomId === roomId) : undefined;
  const file = route?.[2] === "send" ? null : FILE_PATH.exec(url.pathname.slice("/api".length));
  const action = file ? fileAction(file) : "send";
  if (file && group && (method === "DELETE" || (method === "GET" && !file[2]))) {
    if (deps.botCaller) reply(res, 403, { error: "forbidden" });
    else {
      try {
        if (method === "GET") reply(res, 200, listRoomFiles(roomId!, deps.hostName?.() ?? "The host"));
        else if (!file[2] || file[3]) reply(res, 404, { error: "not found" });
        else {
          await deleteRoomFile(roomId!, file[2]);
          if (group.picture === file[2]) deps.store.patchGroup(group.id, { picture: undefined });
          for (const message of deps.store.messagesFor(group.threadId)) {
            if (!message.roomFiles?.some((each) => each.id === file[2])) continue;
            deps.store.patchMessage(group.threadId, message.id, { roomFiles: message.roomFiles.map((each) => each.id === file[2] ? { ...each, deleted: true } : each) });
          }
          broadcastDoorDeleted(roomId!, [file[2]], deletedRoomFiles(roomId!).count);
          reply(res, 200, { ok: true });
        }
      } catch { reply(res, 503, { error: "room files folder is unavailable" }); }
    }
    return true;
  }
  if (!route || !group || method !== (action === "upload" || action === "send" ? "POST" : "GET")) {
    reply(res, 404, { error: "not found" });
    return true;
  }
  if (deps.botCaller) {
    reply(res, 403, { error: "forbidden" });
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
