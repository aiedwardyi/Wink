export type CleanFile = "MEMORY.md" | `memory/${string}.md`;
export type ChangeList = { version: 1; file: CleanFile; changes: Change[] };
export type Change =
  | { op: "merge"; ids: number[]; text: string; reason: string }
  | { op: "replace"; id: number; newer: number; reason: string }
  | { op: "retire"; id: number; reason: string }
  | { op: "split"; id: number; keep: string[]; reason: string }
  | { op: "remind"; id: number; text: string; reason: string }
  | { op: "learn"; text: string; quote: string; lesson: boolean; reason: string }
  | { op: "own"; id: number; quote: string; reason: string }
  | { op: "file"; ids: number[]; topic: string; pointer?: string; reason: string };
export type RejectReason = "shape" | "unknown-id" | "reused-id" | "protected" | "fact-lost" | "too-long" |
  "not-newer" | "not-verbatim" | "op-not-allowed" | "pointer" | "cap-lines" | "cap-chars" | "budget" | "not-quoted" | "secret" | "cap-learn" | "cap-file" | "cap-growth" | "cap-total" | "packet";
type FileInfo = { beforeBytes: number; afterBytes: number; beforeHash: string; afterHash: string };
export type SleepCounts = { kept: number; merged: number; forgot: number; learned: number; filed: number };
export type RunHeader =
  | { v: 1; runId: string; at: number; files: Partial<Record<CleanFile, FileInfo>>; merged: number; replaced: number; moved: number }
  | { v: 2; runId: string; at: number; through: number; files: Partial<Record<CleanFile, FileInfo>>; counts: SleepCounts };
export type EntryHeader = {
  file: CleanFile; op: Change["op"]; at: number[]; prev: string[]; wrote: string[];
  after?: number; quote?: string; lesson?: boolean; topic?: CleanFile; owned?: string[];
};
export type SleepLine = { text: string; at: number; kind: "remember" | "correction" | "said"; context?: string };
export type SleepItem = { op: Change["op"]; file: CleanFile; old: string[]; new: string | null; reason: string; quote?: string };
export type UndoRecord = { v: 1; runId: string; at: number; restored: number; skipped: number };
export type ArchiveEntry = { header: EntryHeader; reason: string; lines: string[] };
export type HistoryRun = { header: RunHeader; entries: ArchiveEntry[]; undo: UndoRecord | null };
export type MemoryCleanState = { version: 1; bots: Record<string, BotCleanState> };
export type BotCleanState = {
  lastRun?: { runId: string; at: number; files: CleanFile[] };
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
export type ValidateInput = { file: CleanFile; text: string; list: unknown; typed: ReadonlySet<string>; user?: readonly SleepLine[]; side?: CleanFile };
export type CleanBudget = { beforeBytes: number; finalBytes: number; maxBytes: number; forcedBytes: number; generatedBytes: number; touchedLines: number; changedChars: number; finalLines: number; maxLines: number; excessBytes: number };
export type ValidateResult =
  | { ok: true; text: string; entries: ArchiveEntry[]; counts: { merged: number; replaced: number; moved: number }; topics: Array<{ file: CleanFile; lines: string[]; reason: string }>; forced: number; budget?: CleanBudget }
  | { ok: false; errors: Array<{ reason: RejectReason; change?: number; over?: number }>; budget?: CleanBudget };
export type TextCall = (prompt: string, opts?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<string | { text: string; tokens?: number }>;
export type CleanInput = {
  memory: string;
  side?: { file: CleanFile; text: string };
  history: string | null;
  typed: ReadonlySet<string>;
  user?: readonly SleepLine[];
  through?: number;
  topic?(file: CleanFile): string | null;
  propose: TextCall;
  recall: TextCall;
  now?: number;
  signal?: AbortSignal;
};
export type CleanResult =
  | { ok: true; runId: string; memory: string; side?: { file: CleanFile; text: string }; topics: Array<{ file: CleanFile; before: string | null; text: string }>; owned: string[];
    block: string; header: RunHeader; recall: { asked: number; passed: number; wrong: number }; tokens: number;
    routeReads: Array<{ id: number; question: string; file: string; hash: string }>; budgets: Array<CleanBudget & { file: CleanFile }> }
  | { ok: false; stage: "nothing" | "propose" | "validate" | "recall" | "aborted"; detail: string; tokens?: number };
