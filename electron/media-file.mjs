import fs from "node:fs/promises";
import path from "node:path";

import { imageBytes, imageFetchFor, resolveOpenTarget, saveImageCopy } from "./open-file.mjs";

export function registerMediaImageIpc(ipcMain, { trusted, optionsFor }) {
  const source = (event, raw) => {
    if (!trusted(event)) throw new Error("Untrusted image caller");
    if (typeof raw !== "string" || !raw) throw new Error("That image URL is invalid");
    const options = optionsFor(event);
    const url = new URL(raw, options.origin);
    if (!["http:", "https:"].includes(url.protocol) && !(url.protocol === "data:" && raw.startsWith("data:image/"))) throw new Error("That image URL is invalid");
    return { src: url.href, options, fetchImpl: imageFetchFor(url.href, options) };
  };
  ipcMain.handle("desktop:read-media-image", async (event, raw) => {
    const { src, fetchImpl } = source(event, raw);
    let type = src.startsWith("data:") ? src.slice(5).split(/[;,]/, 1)[0] : "";
    const bytes = await imageBytes(src, async (url, init) => {
      const response = await fetchImpl(url, init);
      type = response.headers.get("content-type")?.split(";", 1)[0] ?? "";
      return response;
    });
    return { bytes, type };
  });
  ipcMain.handle("desktop:save-media-image", async (event, raw, name) => {
    const { src, options, fetchImpl } = source(event, raw);
    return saveImageCopy(src, { ...options, name, fetchImpl });
  });
}

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
