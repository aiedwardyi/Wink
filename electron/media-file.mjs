import fs from "node:fs/promises";
import path from "node:path";

import { resolveOpenTarget } from "./open-file.mjs";

export async function localMediaFile(file, { dataDir, fsp = fs, platform = process.platform }) {
  try {
    let rawPath = file?.path;
    let base;
    if (!rawPath && typeof file?.src === "string") {
      const attachment = file.src.match(/^\/api\/attachments\/([^/?#]+)$/);
      const room = file.src.match(/^\/api\/rooms\/([a-zA-Z0-9_-]+)\/files\/([A-Za-z0-9_-]{24})(?:\/preview)?$/);
      if (attachment) {
        const name = decodeURIComponent(attachment[1]);
        if (!name || name === "." || name === ".." || /[\\/:]/.test(name)) return null;
        base = path.join(dataDir, "attachments");
        rawPath = path.join(base, name);
      } else if (room) {
        let root = path.join(dataDir, "room-files");
        try {
          const saved = JSON.parse(await fsp.readFile(path.join(dataDir, "room-files-folder.json"), "utf8"));
          if (typeof saved.path !== "string" || !path.isAbsolute(saved.path)) return null;
          root = saved.path;
        } catch (error) { if (error.code !== "ENOENT") return null; }
        base = path.join(root, room[1]);
        rawPath = path.join(base, room[2]);
      }
    }
    const target = await resolveOpenTarget(rawPath, { base, fsp, platform });
    return target.directory ? null : target.filePath;
  } catch { return null; }
}
