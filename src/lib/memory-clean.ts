import { useCallback, useEffect, useRef, useState } from "react";
import { fetchResponse } from "./api-request";
import type { Message } from "@/state/store";

export type CleanFile = "MEMORY.md" | `memory/${string}.md`;
export type MemoryCleanSummary = { run: MemoryCleanRun | null };
export type MemoryCleanRun = {
  runId: string;
  at: number;
  files: CleanFile[];
  beforeBytes: number;
  afterBytes: number;
  merged: number;
  replaced: number;
  moved: number;
  undoneAt: number | null;
  undoable: boolean;
};
export type MemoryCleanUndoResult =
  | { ok: true; revision: string; restored: number; skipped: number }
  | { ok: false; error: "no-run" | "not-newest" | "undone" | "busy" };

const listeners = new Map<string, Set<() => void>>();
const pending = new Map<string, { signature: string; read: Promise<MemoryCleanRun | null> }>();

function readSummary(botId: string, signature: string): Promise<MemoryCleanRun | null> {
  const current = pending.get(botId);
  if (current?.signature === signature) return current.read;
  const read = fetchResponse(`/api/bots/${botId}/memory/clean`).then(async (response) =>
    response.status === 200 ? ((await response.json()) as MemoryCleanSummary).run : null,
  ).catch(() => null).finally(() => {
    if (pending.get(botId)?.read === read) pending.delete(botId);
  });
  pending.set(botId, { signature, read });
  return read;
}

export function useMemoryClean(botId: string, messages: readonly Message[], active = true) {
  const [run, setRun] = useState<MemoryCleanRun | null>(null);
  const generation = useRef(0);
  const busy = useRef(false);
  const signature = messages.filter((message) => message.tool?.tidy).map((message) => `${message.id}:${message.tool!.tidy!.runId}:${message.tool!.tidy!.undoneAt ?? ""}`).join("|");
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    const next = await readSummary(botId, signature);
    if (generation.current === request) setRun(next);
  }, [botId, signature]);
  useEffect(() => {
    const set = listeners.get(botId) ?? new Set<() => void>();
    const read = () => { void refresh(); };
    listeners.set(botId, set);
    set.add(read);
    return () => {
      set.delete(read);
      if (!set.size) listeners.delete(botId);
      generation.current++;
    };
  }, [botId, refresh]);
  const seenSignature = useRef(signature);
  useEffect(() => {
    const changed = seenSignature.current !== signature;
    seenSignature.current = signature;
    if (active || changed) void refresh();
  }, [active, botId, signature, refresh]);
  const undo = async () => {
    if (!run?.undoable || busy.current) return;
    busy.current = true;
    try {
      const response = await fetchResponse(`/api/bots/${botId}/memory/clean/undo`, { method: "POST", body: JSON.stringify({ runId: run.runId }) });
      const body = await response.json() as MemoryCleanUndoResult;
      if (response.status === 409 && !body.ok && body.error === "busy") return;
      setRun(response.status === 200 && body.ok ? { ...run, undoneAt: Date.now(), undoable: false } : null);
      if ((response.status === 200 && body.ok) || response.status === 404 || response.status === 409) {
        pending.delete(botId);
        listeners.get(botId)?.forEach((listener) => listener());
      }
    } catch { setRun(null); }
    finally { busy.current = false; }
  };
  return { run, undo };
}
