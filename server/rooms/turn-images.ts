import { createHash } from "node:crypto";
import { constants, copyFile, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ATTACHMENTS_DIR, ensureAttachmentsDir, extensionForMime } from "../attachments.ts";
import type { Message } from "../store.ts";
import { roomFile } from "./files.ts";
import { holdRoomFiles, roomFilesRoot } from "./files-folder.ts";

export async function roomTurnMessages(roomId: string | undefined, messages: Message[]): Promise<Message[]> {
  if (!roomId || !messages.some((message) => message.roomFiles?.some((file) => !file.deleted && file.type.startsWith("image/")))) return messages;
  let release: () => void;
  try {
    release = holdRoomFiles();
  } catch {
    return messages;
  }
  try {
    const folder = join(roomFilesRoot(), roomId);
    const out: Message[] = [];
    for (const message of messages) {
      const tags: string[] = [];
      for (const attached of message.roomFiles ?? []) {
        if (attached.deleted) continue;
        try {
          const file = roomFile(roomId, attached.id);
          const ext = file && extensionForMime(file.type);
          if (!file || !ext) continue;
          const source = await realpath(join(folder, file.id));
          if (dirname(source) !== await realpath(folder) || (await stat(source)).size !== file.bytes) continue;
          const key = createHash("sha256").update(`${roomId}\n${file.id}\n${file.sha256}`).digest("hex");
          const target = join(ATTACHMENTS_DIR, `room-${key}${ext}`);
          // Native image blocks accept only files inside the attachment store.
          ensureAttachmentsDir();
          await copyFile(source, target, constants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error;
          });
          if ((await stat(target)).size !== file.bytes) continue;
          const path = target.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\r", "&#13;").replaceAll("\n", "&#10;");
          tags.push(`<attached-image path="${path}" />`);
        } catch {
          // A missing or deleted blob must not discard the rest of the conversation.
        }
      }
      out.push(tags.length ? { ...message, text: [message.text, ...tags].filter(Boolean).join("\n") } : message);
    }
    return out;
  } finally {
    release();
  }
}
