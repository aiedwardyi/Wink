import { existsSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { GOOGLE_BINDING_FILE, GOOGLE_TABLE_FILE } from "./google-sync.ts";
import { messageDatabase } from "./message-db.ts";
import { saveProfileSyncSettings, type ProfileSyncSettings } from "./profile-sync.ts";

const DISCONNECTED = "profile-sync-disconnected";

export function disconnectSyncFolder(dataDir: string, settings: ProfileSyncSettings): ProfileSyncSettings {
  // A folder can be disconnected before its first transfer leaves any history.
  if (settings.folder) writeFileAtomic(join(dataDir, DISCONNECTED), "1\n");
  return saveProfileSyncSettings(dataDir, { ...settings, folder: null });
}

export function hasJoinedSync(settings: ProfileSyncSettings): boolean {
  if (settings.folder || settings.syncChats || settings.seenCheckpoint || settings.nextSequence > 1 ||
    Object.keys(settings.botMap).length || Object.keys(settings.syncedHashes).length) return true;
  const records = [DISCONNECTED, GOOGLE_BINDING_FILE, GOOGLE_TABLE_FILE, "thread-sync.json", "thread-sync-rows", "thread-sync-v2-cutover.json"];
  if (records.some((name) => existsSync(join(DATA_DIR, name)))) return true;
  // A restored transcript database can retain peer heads or segments without the old settings files.
  const db = messageDatabase();
  return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'sync_v2_heads'").get() &&
    db.prepare("SELECT 1 FROM sync_v2_heads UNION ALL SELECT 1 FROM sync_v2_files LIMIT 1").get());
}
