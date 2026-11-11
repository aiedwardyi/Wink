// The teammate's own copies of a joined room's files, fetched through the door
// with the guest key and checked against the entry's sha256 before they count.
import { createHash, randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import { DATA_DIR } from "../config.ts";
import { sendBlob, writeAll } from "./files.ts";
import type { GuestClient, GuestResult } from "./guest-client.ts";
import type { JoinedFile } from "./joined.ts";

const roomDir = (roomId: string) => join(DATA_DIR, "joined-files", roomId);

/** The held copy, when it is all there. */
export function cachedJoinedFile(roomId: string, file: JoinedFile): string | null {
  const path = join(roomDir(roomId), file.id);
  try {
    return statSync(path).size === file.bytes ? path : null;
  } catch {
    return null;
  }
}

/** Streams a download into the cache; false unless every byte matched, cut past `file.bytes`. */
export async function keepJoinedFile(roomId: string, file: JoinedFile, body: IncomingMessage): Promise<boolean> {
  const dir = roomDir(roomId);
  const temp = join(dir, `.${randomBytes(9).toString("base64url")}.tmp`);
  const hash = createHash("sha256");
  let size = 0;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const handle = await open(temp, "wx", 0o600);
    try {
      for await (const chunk of body as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > file.bytes) break;
        hash.update(chunk);
        await writeAll(handle, chunk);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (size !== file.bytes || hash.digest("hex") !== file.sha256) throw new Error("mismatch");
    await rename(temp, join(dir, file.id));
    return true;
  } catch {
    body.destroy();
    await rm(temp, { force: true }).catch(() => {});
    return false;
  }
}

const ROUTE = /^\/api\/joined\/rooms\/([\w-]{1,64})\/files(?:\/([A-Za-z0-9_-]{24})(\/preview)?)?$/;

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** Local only, like the rest of /api/joined/. False when the path isn't a file route. */
export async function joinedFileRoute(
  req: IncomingMessage, res: ServerResponse, method: string, url: URL, client: Pick<GuestClient, "start" | "upload" | "file">,
): Promise<boolean> {
  const route = ROUTE.exec(url.pathname);
  if (!route) return false;
  const [, roomId, fileId, preview] = route as unknown as [string, string, string | undefined, string | undefined];
  if (method === "DELETE" && fileId) {
    reply(res, 403, { error: "forbidden" });
    return true;
  }
  if (method !== (fileId ? "GET" : "POST")) {
    reply(res, 404, { error: "not found" });
    return true;
  }
  client.start();
  if (!fileId) {
    const result = await client.upload(roomId, req, url.searchParams.get("name") ?? "", url.searchParams.get("uploadId") ?? "", req.headers["content-length"]);
    const extra = result.uploadId ? { uploadId: result.uploadId } : {};
    reply(res, result.ok ? 200 : result.status, result.ok ? { file: result.value, ...extra } : { error: result.error, ...extra });
    return true;
  }
  const held: GuestResult<{ file: JoinedFile; path: string }> = await client.file(roomId, fileId);
  if (!held.ok) reply(res, held.status, { error: held.error });
  else if (!(await sendBlob(res, held.value.path, held.value.file, preview !== undefined))) reply(res, 404, { error: "not found" });
  return true;
}
