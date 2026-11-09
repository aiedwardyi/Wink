// What a thread's main turn is doing right now, from the bus: its open tool
// calls and the files it wrote. A quick ask gets this as facts, because a
// resumed fork sees an open call with no result and reads it as interrupted.
import { basename } from "node:path";

import type { RuntimeEvent } from "./contracts.ts";

const CAP = 600;
const CUT = "… (list incomplete)]";
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

interface Turn {
  open: Map<string, { tool: string; at: number; writes?: string }>;
  /** newest last */
  wrote: string[];
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
    // the start's summary holds the workspace-relative path; absolute ones blow the cap after 2-3 files
    for (const path of event.writes?.length === 1 && shown ? [shown] : (event.writes ?? [])) turn.wrote = [...turn.wrote.filter((seen) => seen !== path), path];
  }
}

/** One short block for the next quick ask; "" when nothing is open or written. */
export function liveBlock(threadId: string, now = Date.now()): string {
  const turn = turns.get(threadId);
  if (!turn || (!turn.open.size && !turn.wrote.length)) return "";
  const lines: string[] = [];
  if (turn.open.size) {
    const open = [...turn.open.values()].map(({ tool, at }) => `${tool} (started ${Math.max(0, Math.round((now - at) / 1000))} s ago)`);
    lines.push(`- Open now, still running, no result yet: ${open.join("; ")}.`);
  }
  if (turn.wrote.length) lines.push(`- Files the main task changed this turn: read before quoting or naming one, in this ask, or your answer is dropped: ${[...turn.wrote].reverse().join(", ")}`);
  const block = `[Main task right now, as of ${new Date(now).toTimeString().slice(0, 8)}, from Wink:\n${lines.join("\n")}`;
  return block.length + 1 > CAP ? `${block.slice(0, CAP - CUT.length)}${CUT}` : `${block}]`;
}

/** True when the answer names a file the main changed or is writing that this ask never Read. */
export function quotesUnread(threadId: string, answer: string, reads: string[]): boolean {
  const turn = turns.get(threadId);
  if (!turn) return false;
  const read = new Set(reads.map(fileName));
  const text = answer.toLowerCase();
  const touched = [...turn.wrote, ...[...turn.open.values()].flatMap((item) => (item.writes ? [item.writes] : []))].map(fileName);
  return touched.some((name) => name && !read.has(name) && text.includes(name));
}
