// A room report tied to the worker pane fixing it: "Fix started" when linked, "Fixed in <version>" once an offered update carries the merged work.
import { mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

import { parsePaneNote } from "../shared/pane-note.ts";
import { writeFileAtomic } from "./atomic.ts";
import { linkRoomEntry } from "./rooms/mirror.ts";
import type { BotRecord, GroupRecord, Message, Store } from "./store.ts";

const FILE = "room-fixes.json";
const KEEP = 200;
const TITLE_CHARS = 80;
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const BRANCH = /^(?!-)[\w./-]{1,200}$/;
const OID = /^[0-9a-f]{40,64}$/;

const fixSchema = z.object({
  botId: z.string(),
  groupId: z.string(),
  sessionId: z.string(),
  title: z.string(),
  lang: z.enum(["en", "ko"]),
  at: z.number(),
  gitDir: z.string().optional(),
  fixedIn: z.string().optional(),
});
type RoomFix = z.infer<typeof fixSchema>;

const mergedSchema = z.array(z.object({ url: z.string(), mergedAt: z.string().nullish(), mergeCommit: z.object({ oid: z.string() }).nullish() }));

export type RoomFixStore = Pick<Store, "bot" | "group" | "groupByThread" | "appendMessage" | "patchMessage" | "patchGroup" | "activePath"> & { groups: readonly GroupRecord[] };

export type RoomFixDeps = {
  dataDir: string;
  store: RoomFixStore;
  /** The bot's own pane, read back from the terminal bridge; null for an unknown pane or the main terminal. */
  pane: (botId: string, sessionId: string) => Promise<{ sessionId: string; cwd: string } | null>;
  git: (cwd: string, args: string[]) => Promise<string>;
  gh: (cwd: string, args: string[]) => Promise<string>;
  now?: () => number;
};

export type RoomFixLink = { botId: string; threadId: string; sessionId: string; title: string; room?: string | undefined };

function readFixes(dataDir: string): RoomFix[] {
  try {
    const rows: unknown = JSON.parse(readFileSync(join(dataDir, FILE), "utf8"));
    return Array.isArray(rows) ? rows.flatMap((row) => { const parsed = fixSchema.safeParse(row); return parsed.success ? [parsed.data] : []; }) : [];
  } catch {
    return [];
  }
}

function cleanTitle(value: string): string {
  // oxlint-disable-next-line no-control-regex -- titles come from a model's tool call
  const title = value.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  return title.length > TITLE_CHARS ? `${title.slice(0, TITLE_CHARS - 1).replace(/[\ud800-\udbff]$/, "")}…` : title;
}

function roomFor(store: RoomFixStore, bot: BotRecord, threadId: string, name: string | undefined): { group: GroupRecord } | { error: string } {
  const mine = store.groups.filter((group) => !group.dm && group.memberIds.includes(bot.id));
  const wanted = name?.trim().toLowerCase();
  if (wanted) {
    const named = mine.filter((group) => group.name.trim().toLowerCase() === wanted);
    if (named.length === 1) return { group: named[0]! };
    return { error: named.length ? `Several of your rooms are named "${name}".` : `You have no room named "${name}". Your rooms: ${mine.map((group) => group.name).join(", ") || "none"}.` };
  }
  const here = store.groupByThread(threadId);
  return here && !here.dm && here.memberIds.includes(bot.id) ? { group: here } : { error: "This turn is not in a room. Pass room: the name of the room the report came from." };
}

/** The branch a pane's newest DONE report names, from its `branch=` header field. */
export function reportedBranch(messages: readonly Message[], sessionId: string): string | null {
  const pane8 = sessionId.slice(0, 8).toLowerCase();
  for (let index = messages.length - 1; index >= 0; index--) {
    const text = messages[index]!.kind === "note" ? messages[index]!.text : undefined;
    if (!text) continue;
    const note = parsePaneNote(text);
    if (note.pane8 !== pane8 || note.status !== "done") continue;
    const branch = / branch=(\S+)/.exec(text.split("\n", 1)[0]!)?.[1];
    if (branch && branch !== "HEAD" && BRANCH.test(branch)) return branch;
  }
  return null;
}

export function createRoomFixes(deps: RoomFixDeps) {
  const now = deps.now ?? Date.now;
  const fixes = readFixes(deps.dataDir);
  let queue: Promise<void> = Promise.resolve();
  const save = () => {
    if (fixes.length > KEEP) fixes.splice(0, fixes.length - KEEP);
    mkdirSync(deps.dataDir, { recursive: true });
    writeFileAtomic(join(deps.dataDir, FILE), JSON.stringify(fixes, null, 2));
  };
  const post = async (fix: RoomFix, key: "room.fixStarted" | "room.fixedIn", vars: Record<string, string>) => {
    const bot = deps.store.bot(fix.botId);
    const group = deps.store.group(fix.groupId);
    if (!bot || !group || !group.memberIds.includes(bot.id)) return;
    const { catalogs } = await import("../src/lib/i18n-catalog.ts");
    let text: string = catalogs[fix.lang][key];
    for (const [name, value] of Object.entries(vars)) text = text.replaceAll(`{${name}}`, () => value);
    const row = deps.store.appendMessage(group.threadId, { role: "bot", kind: "text", text, from: { botId: bot.id, name: bot.name, color: bot.color } });
    linkRoomEntry(deps.store, group, row);
    deps.store.patchGroup(group.id, { unread: true });
  };
  const shipped = async (fix: RoomFix, version: string): Promise<boolean> => {
    const bot = deps.store.bot(fix.botId);
    const branch = bot && fix.gitDir ? reportedBranch(deps.store.activePath(bot.threadId), fix.sessionId) : null;
    if (!branch || !fix.gitDir) return false;
    const cwd = basename(fix.gitDir) === ".git" ? dirname(fix.gitDir) : fix.gitDir;
    try {
      const merged = mergedSchema.parse(JSON.parse(await deps.gh(cwd, ["pr", "list", `--head=${branch}`, "--state=merged", "--json=url,mergedAt,mergeCommit", "--limit=10"])))
        .filter((pr) => Date.parse(pr.mergedAt ?? "") >= fix.at && OID.test(pr.mergeCommit?.oid ?? ""));
      for (const pr of merged) {
        const repo = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+$/.exec(pr.url)?.[1];
        if (!repo) continue;
        // ahead or identical: the release tag holds the merge commit
        const status = (await deps.gh(cwd, ["api", `repos/${repo}/compare/${pr.mergeCommit!.oid}...v${version}`, "--jq=.status"]).catch(() => "")).trim();
        if (status === "ahead" || status === "identical") return true;
      }
    } catch {}
    return false;
  };
  const check = async (version: string) => {
    for (const fix of fixes.filter((row) => !row.fixedIn)) {
      if (!(await shipped(fix, version)) || fix.fixedIn) continue;
      fix.fixedIn = version;
      save();
      await post(fix, "room.fixedIn", { version, title: fix.title });
    }
  };
  return {
    async link(input: RoomFixLink): Promise<{ text: string } | { error: string }> {
      const bot = deps.store.bot(input.botId);
      if (!bot) return { error: "unknown sender" };
      const title = cleanTitle(input.title);
      if (!title) return { error: "link_room_fix needs a title." };
      const found = roomFor(deps.store, bot, input.threadId, input.room);
      if ("error" in found) return found;
      const { group } = found;
      const pane = input.sessionId.trim() ? await deps.pane(bot.id, input.sessionId.trim()) : null;
      if (!pane) return { error: "Unknown pane. Pass the sessionId terminal_spawn returned." };
      const gitDir = pane.cwd ? (await deps.git(pane.cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => "")).trim() : "";
      // after the last await, so two calls for one pane cannot both post
      if (fixes.some((fix) => fix.groupId === group.id && fix.sessionId === pane.sessionId)) return { text: `Already linked to "${group.name}".` };
      const fix: RoomFix = { botId: bot.id, groupId: group.id, sessionId: pane.sessionId, title, lang: HANGUL.test(title) ? "ko" : "en", at: now() };
      if (gitDir) fix.gitDir = gitDir;
      fixes.push(fix);
      save();
      await post(fix, "room.fixStarted", { title });
      return { text: `Posted the fix start in "${group.name}". Wink posts the release there once an update offered to the user contains the merged work; never post either line yourself.` };
    },
    /** Updater offers and the running version; a merge alone never counts. */
    released(version: string): Promise<void> {
      if (!VERSION.test(version)) return queue;
      queue = queue.then(() => check(version)).catch(() => {});
      return queue;
    },
  };
}

export type RoomFixes = ReturnType<typeof createRoomFixes>;
