export type CleanFile = "MEMORY.md" | `memory/${string}.md`;
export type ChangeList = { version: 1; file: CleanFile; changes: Change[] };
export type Change =
  | { op: "merge"; ids: number[]; text: string; reason: string }
  | { op: "replace"; id: number; newer: number; reason: string }
  | { op: "retire"; id: number; reason: string }
  | { op: "split"; id: number; keep: string[]; reason: string }
  | { op: "remind"; id: number; text: string; reason: string };
export type RejectReason = "shape" | "unknown-id" | "reused-id" | "protected" | "fact-lost" | "too-long" |
  "not-newer" | "not-verbatim" | "op-not-allowed" | "pointer" | "cap-lines" | "cap-chars" | "budget";
export type RunHeader = {
  v: 1;
  runId: string;
  at: number;
  files: Partial<Record<CleanFile, { beforeBytes: number; afterBytes: number; beforeHash: string; afterHash: string }>>;
  merged: number;
  replaced: number;
  moved: number;
};
export type EntryHeader = { file: CleanFile; op: Change["op"]; at: number[]; prev: string[]; wrote: string[] };
export type UndoRecord = { v: 1; runId: string; at: number; restored: number; skipped: number };
export type ArchiveEntry = { header: EntryHeader; reason: string; lines: string[] };
export type HistoryRun = { header: RunHeader; entries: ArchiveEntry[]; undo: UndoRecord | null };
export type MemoryCleanState = { version: 1; bots: Record<string, BotCleanState> };
export type BotCleanState = {
  checkedAt?: number;
  queued?: { at: number; reason: "size" | "dropped" };
  lastRun?: { runId: string; at: number; files: CleanFile[] };
  cooldownUntil?: number;
  attemptedAt?: number;
  unchangedHash?: string;
  backoff?: Partial<Record<CleanFile, number>>;
  sideHashes?: Partial<Record<CleanFile, string>>;
  typed?: string[];
};
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
export type MergeParkedInput = { file: string; kept: string; parked: string; history: string | null };
export type ValidateInput = { file: CleanFile; text: string; list: unknown; typed: ReadonlySet<string> };
export type ValidateResult =
  | { ok: true; text: string; entries: ArchiveEntry[]; counts: { merged: number; replaced: number; moved: number } }
  | { ok: false; errors: Array<{ reason: RejectReason; change?: number }> };
export type TextCall = (prompt: string, opts?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<string>;
export type CleanInput = {
  memory: string;
  side?: { file: CleanFile; text: string };
  history: string | null;
  typed: ReadonlySet<string>;
  propose: TextCall;
  recall: TextCall;
  now?: number;
  signal?: AbortSignal;
};
export type CleanResult =
  | { ok: true; runId: string; memory: string; side?: { file: CleanFile; text: string }; block: string; header: RunHeader; recall: { asked: number; passed: number; wrong: number } }
  | { ok: false; stage: "nothing" | "propose" | "validate" | "recall" | "aborted"; detail: string };
