import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";

const journalSchema = z.object({ v: z.literal(1), files: z.array(z.object({ path: z.string().min(1), data: z.string(), mode: z.number().int().nonnegative().optional() }).strict()) }).strict();
type Reloadable = { reload(): void };
type Buffered = { path: string; data: string; mode?: number };

export function createAutoJournal(dataDir: string, write = writeFileAtomic) {
  const file = join(dataDir, "auto-routing-journal.json");
  const stores = new Set<Reloadable>();
  let buffer: Map<string, Buffered> | undefined;
  const replay = () => {
    if (!existsSync(file)) return;
    const journal = journalSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    for (const item of journal.files) write(join(dataDir, item.path), item.data, { mode: item.mode });
    unlinkSync(file);
  };
  const rollback = () => {
    buffer = undefined;
    for (const store of stores) store.reload();
  };
  replay();
  return {
    write(path: string, data: string, options: { mode?: number } = {}): void {
      if (buffer) { buffer.set(path, { path: relative(dataDir, path), data, mode: options.mode }); return; }
      replay();
      write(path, data, options);
    },
    transaction<T>(run: () => T): T {
      if (buffer) return run();
      replay();
      const writes = new Map<string, Buffered>();
      buffer = writes;
      let result: T;
      try {
        result = run();
        if (writes.size) write(file, `${JSON.stringify(journalSchema.parse({ v: 1, files: [...writes.values()] }))}\n`, { mode: 0o600 });
      } catch (error) {
        rollback();
        throw error;
      }
      buffer = undefined;
      try { replay(); } catch { /* Committed; the next write retries this replay. */ }
      return result;
    },
    reloads(...added: Reloadable[]): void { for (const store of added) stores.add(store); },
  };
}
