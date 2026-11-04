import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { syncRoots } from "./sync-roots.ts";

const snapshot = z.object({
  device: z.string().regex(/^[0-9a-f]{12}$/), talkedAt: z.number().finite().nonnegative(),
  typed: z.array(z.string().regex(/^[0-9a-f]{16}$/)).max(2000).optional().catch(undefined),
}).passthrough();

export type HomeInput = { folder?: string; botSyncId?: string; device: string; talkedAt?: number };

export function memoryCleanHome(input: HomeInput): { home: boolean; typed: Set<string>; fence: string } {
  const typed = new Set<string>();
  if (!input.folder) return { home: true, typed, fence: "" };
  if (!/^[0-9a-f]{12}$/.test(input.device) || !input.botSyncId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(input.botSyncId)) return { home: false, typed, fence: "" };
  try {
    readdirSync(input.folder);
    const ranks = [{ device: input.device, talkedAt: input.talkedAt ?? 0 }];
    const seen: string[] = [];
    for (const root of syncRoots(input.folder, "memory-v2")) {
      let files: string[];
      try { files = readdirSync(join(root, input.botSyncId)); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const file of files.filter((name) => /^[0-9a-f]{12}\.json$/.test(name)).sort()) {
        const text = readFileSync(join(root, input.botSyncId, file), "utf8");
        const parsed = snapshot.parse(JSON.parse(text));
        if (`${parsed.device}.json` !== file) return { home: false, typed, fence: "" };
        ranks.push(parsed);
        parsed.typed?.forEach((hash) => typed.add(hash));
        seen.push(`${root}/${file}:${text}`);
      }
    }
    ranks.sort((a, b) => b.talkedAt - a.talkedAt || a.device.localeCompare(b.device));
    return { home: ranks[0]?.device === input.device, typed, fence: JSON.stringify(seen) };
  } catch { return { home: false, typed, fence: "" }; }
}
