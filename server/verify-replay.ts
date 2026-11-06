import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { chunk, decodeChunks, REPLAY_LIMIT } from "../electron/verify-replay.mjs";
import { DATA_DIR } from "./config.ts";

export const VERIFY_REPLAYS_DIR = join(DATA_DIR, "verify-replays");
const id = (value: string) => /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const runId = (value: string) => /^[a-z0-9-]{8,64}$/.test(value);
type Row = { bytes: Buffer; kind: number; tile?: string; protected?: boolean };
type Index = Record<string, { card: string; order: number }>;
let writes = Promise.resolve();

async function readIndex(root: string): Promise<Index> {
  try { return JSON.parse(await readFile(join(root, "index.json"), "utf8")) as Index; }
  catch { return {}; }
}

export async function pruneReplays(root = VERIFY_REPLAYS_DIR, now = Date.now(), limit = 200 * 1024 * 1024): Promise<Map<string, string[]>> {
  const index = await readIndex(root), files = [];
  for (const thread of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!thread.isDirectory() || !id(thread.name)) continue;
    for (const file of await readdir(join(root, thread.name), { withFileTypes: true })) {
      const name = file.name.slice(0, -4);
      if (!file.isFile() || !file.name.endsWith(".lvr") || !runId(name)) continue;
      const path = join(root, thread.name, file.name), info = await stat(path);
      const key = `${thread.name}/${name}`;
      files.push({ path, key, thread: thread.name, runId: name, card: index[key]?.card ?? "", order: index[key]?.order ?? 0, at: info.mtimeMs, size: info.size });
    }
  }
  files.sort((a, b) => b.at - a.at || b.order - a.order || b.runId.localeCompare(a.runId));
  const counts = new Map<string, number>(), kept = new Map<string, string[]>(), next: Index = {};
  const selected = [];
  for (const file of files) {
    const key = `${file.thread}/${file.card}`, n = counts.get(key) ?? 0;
    if (now - file.at > 7 * 86400_000 || n >= 3) {
      await unlink(file.path);
      continue;
    }
    counts.set(key, n + 1); selected.push(file);
  }
  let total = selected.reduce((size, file) => size + file.size, 0);
  while (total > limit && selected.length) {
    const file = selected.pop()!;
    total -= file.size; await unlink(file.path);
  }
  for (const file of selected) {
    const key = `${file.thread}/${file.card}`;
    next[file.key] = { card: file.card, order: file.order };
    kept.set(key, [file.runId, ...(kept.get(key) ?? [])]);
  }
  await writeFile(join(root, "index.json.tmp"), JSON.stringify(next), { mode: 0o600 });
  await rename(join(root, "index.json.tmp"), join(root, "index.json"));
  return kept;
}

export function createReplay(head: { runId: string; [key: string]: unknown }) {
  const header = chunk(0, head), rows: Row[] = [{ bytes: header, kind: 0 }], latest = new Map<string, Row>(), afterScroll = new Set<string>();
  const listeners = new Set<(bytes: Buffer) => boolean>();
  let size = header.length + 4, markBytes = 0, marks = 0, ended = false;
  const notify = (bytes: Buffer) => { for (const listener of listeners) listener(bytes); };
  function thin() {
    while (size > REPLAY_LIMIT - 32768) {
      let parity = 0, dropped = 0;
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i]!;
        if (row.kind !== 1 || row.protected || latest.get(row.tile!) === row || parity++ % 2) continue;
        size -= row.bytes.length; rows.splice(i--, 1); dropped++;
      }
      if (!dropped) break;
    }
  }
  return {
    add(bytes: Buffer) {
      if (ended) return;
      const decoder = decodeChunks(value => {
        if (value.kind === 0 && rows.length === 1) { size += bytes.length - rows[0]!.bytes.length; rows[0]!.bytes = bytes; return; }
        if (value.kind !== 1 && value.kind !== 2) return;
        if (value.kind === 2 && (marks >= 2000 || markBytes + bytes.length > 2 * 1024 * 1024)) return;
        const row: Row = { bytes, kind: value.kind, tile: value.tile };
        if (row.kind === 1) {
          const previous = latest.get(row.tile!);
          row.protected = afterScroll.has(row.tile!);
          afterScroll.delete(row.tile!); latest.set(row.tile!, row);
          rows.push(row); size += bytes.length; thin();
          if (size > REPLAY_LIMIT - 32768) {
            rows.splice(rows.indexOf(row), 1); size -= bytes.length;
            if (previous && rows.includes(previous)) latest.set(row.tile!, previous); else latest.delete(row.tile!);
            if (row.protected) afterScroll.add(row.tile!);
            return;
          }
        } else {
          size += bytes.length; thin();
          if (size > REPLAY_LIMIT - 32768) { size -= bytes.length; return; }
          marks++; markBytes += bytes.length;
          if (value.tile && value.value.kind === "scroll") afterScroll.add(value.tile);
          rows.push(row);
        }
        notify(bytes);
      });
      decoder.push(bytes); decoder.end();
    },
    finish(value: unknown) {
      if (ended) return;
      ended = true;
      const bytes = chunk(3, value);
      if (size + bytes.length > REPLAY_LIMIT) throw new Error("Replay result cap");
      rows.push({ bytes, kind: 3 }); size += bytes.length; notify(bytes);
    },
    file: () => Buffer.concat([Buffer.from("LVR1"), ...rows.map(row => row.bytes)]),
    subscribe(listener: (bytes: Buffer) => boolean) {
      if (listeners.size >= 2) throw new Error("busy");
      for (const row of [rows[0]!, ...latest.values(), ...rows.filter(row => row.kind === 2 || row.kind === 3)]) listener(row.bytes);
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    save(root: string, threadId: string, cardId: string): Promise<Map<string, string[]>> {
      if (!ended || !id(threadId) || !id(cardId) || !runId(head.runId)) return Promise.reject(new Error("Invalid replay save"));
      const bytes = Buffer.concat([Buffer.from("LVR1"), ...rows.map(row => row.bytes)]);
      const saved = writes.catch(() => {}).then(async () => {
        await mkdir(join(root, threadId), { recursive: true, mode: 0o700 });
        const path = join(root, threadId, `${head.runId}.lvr`);
        await writeFile(path + ".tmp", bytes, { mode: 0o600 });
        await rename(path + ".tmp", path);
        const index = await readIndex(root);
        index[`${threadId}/${head.runId}`] = { card: cardId, order: Math.max(0, ...Object.values(index).map(row => row.order)) + 1 };
        await writeFile(join(root, "index.json.tmp"), JSON.stringify(index), { mode: 0o600 });
        await rename(join(root, "index.json.tmp"), join(root, "index.json"));
        return pruneReplays(root);
      });
      writes = saved.then(() => {}, () => {});
      return saved;
    },
  };
}

export async function replayThread(value: string, root = VERIFY_REPLAYS_DIR): Promise<string | null> {
  if (!runId(value)) return null;
  const key = Object.keys(await readIndex(root)).find(key => key.endsWith(`/${value}`));
  return key ? key.slice(0, key.indexOf("/")) : null;
}

export async function readReplay(threadId: string, value: string, root = VERIFY_REPLAYS_DIR): Promise<Buffer | null> {
  if (!id(threadId) || !runId(value)) return null;
  try {
    const path = join(root, threadId, `${value}.lvr`), info = await stat(path);
    if (Date.now() - info.mtimeMs > 7 * 86400_000 || info.size > REPLAY_LIMIT) return null;
    return await readFile(path);
  } catch { return null; }
}
