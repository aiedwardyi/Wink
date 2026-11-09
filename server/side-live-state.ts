// What a thread's main turn is doing right now, from the bus: its open tool
// calls and the files it wrote. A quick ask gets this as facts, because a
// resumed fork sees an open call with no result and reads it as interrupted.
import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";

import type { RuntimeEvent } from "./contracts.ts";

const CAP = 600;
const CUT = "… (list incomplete)";
const FILE_CAP = 1_536;
const FILES_CAP = 3_072;
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

interface Turn {
  open: Map<string, { tool: string; at: number; writes?: string }>;
  /** newest last */
  wrote: { path: string; shown: string }[];
}

const turns = new Map<string, Turn>();

function turnOf(threadId: string): Turn {
  let turn = turns.get(threadId);
  if (!turn) turns.set(threadId, (turn = { open: new Map(), wrote: [] }));
  return turn;
}

const fileName = (path: string) => basename(path.replaceAll("\\", "/")).toLowerCase();

export function observeLive(event: RuntimeEvent): void {
  if (event.type === "turn.started") turns.set(event.threadId, { open: new Map(), wrote: [] });
  else if (event.type === "turn.completed" || event.type === "session.exited") turns.delete(event.threadId);
  else if (event.type === "item.started" && event.itemType === "tool" && event.itemId) {
    const name = (event.title ?? event.verb ?? "tool").replace(/^mcp__.+?__/, "");
    const target = event.summary?.replace(/ \+\d+( -\d+)?$/, "");
    turnOf(event.threadId).open.set(event.itemId, {
      tool: target ? `${name} ${target}` : name,
      at: Date.parse(event.createdAt) || Date.now(),
      ...(target && WRITE_TOOLS.has(name) ? { writes: target } : {}),
    });
  } else if (event.type === "item.completed" && event.itemType === "tool" && event.itemId) {
    const turn = turns.get(event.threadId);
    if (!turn) return;
    const shown = turn.open.get(event.itemId)?.writes;
    turn.open.delete(event.itemId);
    const writes = event.writes ?? [];
    // the start's summary holds the workspace-relative path; absolute ones blow the cap after 2-3 files
    for (const path of writes) turn.wrote = [...turn.wrote.filter((seen) => seen.path !== path), { path, shown: writes.length === 1 && shown ? shown : path }];
  }
}

/** The file as it is now: its text, undefined once deleted, null when too big, binary or unreadable. */
function current(path: string): string | null | undefined {
  if (!isAbsolute(path)) return null;
  try {
    if (statSync(path).size > FILE_CAP) return null;
    const bytes = readFileSync(path);
    return bytes.includes(0) ? null : bytes.toString("utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null;
  }
}

/** The block for the next quick ask and the files it attached; "" when nothing is open or written. */
export function liveBlock(threadId: string, now = Date.now()): { text: string; attached: string[] } {
  const turn = turns.get(threadId);
  if (!turn || (!turn.open.size && !turn.wrote.length)) return { text: "", attached: [] };
  const stamp = new Date(now).toTimeString().slice(0, 8);
  const writing = new Set([...turn.open.values()].flatMap((item) => (item.writes ? [fileName(item.writes)] : [])));
  const attached: string[] = [];
  const files: string[] = [];
  const unread: string[] = [];
  let budget = FILES_CAP;
  for (const { path, shown } of [...turn.wrote].reverse()) {
    const body = writing.has(fileName(shown)) ? null : current(path);
    const part = body === undefined ? `--- ${shown} (deleted) ---` : `--- ${shown} ---\n${body}`;
    if (body === null || part.length > budget) unread.push(shown);
    else {
      budget -= part.length;
      attached.push(path);
      files.push(part);
    }
  }
  const lines = [`[Main task right now, as of ${stamp}, from Wink:`];
  if (turn.open.size) {
    const open = [...turn.open.values()].map(({ tool, at }) => `${tool} (started ${Math.max(0, Math.round((now - at) / 1000))} s ago)`);
    lines.push(`- Open now, still running, no result yet: ${open.join("; ")}.`);
  }
  if (unread.length) lines.push(`- Files the main task changed this turn: look one up (Read, Grep or Glob) in this ask before quoting or naming it, or your answer is dropped: ${unread.join(", ")}`);
  const head = lines.join("\n");
  const capped = head.length + 1 > CAP ? `${head.slice(0, CAP - 1 - CUT.length)}${CUT}` : head;
  const tail = files.length ? `\n- Files the main task changed this turn, as they are at ${stamp} (already read for you):\n${files.join("\n")}` : "";
  return { text: `${capped}${tail}]`, attached };
}

/** True when the answer names a file the main changed or is writing that this ask never looked up. */
export function quotesUnread(threadId: string, answer: string, reads: string[]): boolean {
  const turn = turns.get(threadId);
  if (!turn) return false;
  const read = new Set(reads.map(fileName));
  const text = answer.toLowerCase();
  const touched = [...turn.wrote.map(({ path }) => path), ...[...turn.open.values()].flatMap((item) => (item.writes ? [item.writes] : []))].map(fileName);
  return touched.some((name) => name && !read.has(name) && text.includes(name));
}
