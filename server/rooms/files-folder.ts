import { createHash } from "node:crypto";
import { accessSync, createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { constants, copyFile, mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import { DATA_DIR } from "../config.ts";

const setting = () => join(DATA_DIR, "room-files-folder.json");
const NESTED = "Wink room files";
const failure = () => Object.assign(new Error("room files folder is unavailable"), { status: 503 });
let moving = false;
let active = 0;

export function roomFilesFolder(): { path: string; error: string | null } {
  let path = join(DATA_DIR, "room-files");
  try {
    const configured = existsSync(setting());
    if (configured) {
      const saved = JSON.parse(readFileSync(setting(), "utf8")) as { path: unknown };
      if (typeof saved.path !== "string" || !isAbsolute(saved.path)) throw failure();
      path = saved.path;
    }
    if (configured || existsSync(path)) {
      accessSync(path, constants.R_OK | constants.W_OK);
      if (!statSync(path).isDirectory()) throw failure();
    }
    return { path, error: null };
  } catch {
    return { path, error: "unavailable" };
  }
}

export function roomFilesRoot(): string {
  const folder = roomFilesFolder();
  if (folder.error) throw failure();
  return folder.path;
}

export function holdRoomFiles(): () => void {
  if (moving) throw failure();
  roomFilesRoot();
  active++;
  return () => { active--; };
}

export const roomFilesBusy = () => moving || active > 0;

async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function moveRoomFiles(raw: unknown): Promise<ReturnType<typeof roomFilesFolder>> {
  if (typeof raw !== "string" || !isAbsolute(raw) || roomFilesBusy()) throw failure();
  const old = roomFilesRoot();
  // A picked folder holds the user's own files; room files live in a folder of their own inside it.
  const next = basename(resolve(raw)) === NESTED ? resolve(raw) : join(resolve(raw), NESTED);
  if (next === old) return roomFilesFolder();
  const inside = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === "" || (!path.startsWith("..") && !isAbsolute(path));
  };
  if (inside(old, next) || inside(next, old)) throw failure();
  const copied: Array<{ source: string; target: string }> = [];
  const removed: typeof copied = [];
  const previous = existsSync(setting()) ? readFileSync(setting(), "utf8") : null;
  moving = true;
  let switched = false;
  try {
    await mkdir(next, { recursive: true, mode: 0o700 });
    for (const room of existsSync(old) ? await readdir(old, { withFileTypes: true }) : []) {
      if (!room.isDirectory() || !/^[\w-]{1,64}$/.test(room.name)) throw failure();
      const dir = join(next, room.name);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      for (const blob of await readdir(join(old, room.name), { withFileTypes: true })) {
        if (!blob.isFile()) throw failure();
        const source = join(old, room.name, blob.name);
        const target = join(dir, blob.name);
        await copyFile(source, target, constants.COPYFILE_EXCL);
        copied.push({ source, target });
        if ((await stat(source)).size !== (await stat(target)).size || await digest(source) !== await digest(target)) throw failure();
        const handle = await open(target, "r+");
        try { await handle.sync(); } finally { await handle.close(); }
      }
    }
    writeFileAtomic(setting(), JSON.stringify({ path: next }), { mode: 0o600 });
    switched = true;
    for (const file of copied) {
      await rm(file.source);
      removed.push(file);
    }
    return roomFilesFolder();
  } catch {
    // Restore the old tree before rolling back its pointer.
    for (const file of removed) await copyFile(file.target, file.source);
    if (switched) {
      if (previous === null) await rm(setting());
      else writeFileAtomic(setting(), previous, { mode: 0o600 });
    }
    for (const file of copied) await rm(file.target, { force: true }).catch(() => {});
    throw failure();
  } finally {
    moving = false;
  }
}
