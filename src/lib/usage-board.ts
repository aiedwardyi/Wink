export type UsageBoardEngineId = "claude" | "codex" | "grok" | "gemini" | "muse";

export type UsageBoardWindow = {
  id: string;
  kind: "session" | "week" | "other";
  usedPercent: number;
  resetsAt: number | null;
  windowMinutes: number | null;
};

// [bucket start in epoch minutes, 5h used %, week used %]; null means no reading in that bucket.
export type UsageBoardSample = [minute: number, session: number | null, week: number | null];

export type UsageBoardEvent = {
  seq: number;
  at: number;
  kind: "main" | "auto" | "limit" | "reset" | "moved";
  accountId?: string;
  window?: string;
  from?: string;
  to?: string;
  paneId?: string;
  label?: string;
};

export type UsageBoardRun = { botId: string; bot: string; paneId: string; label: string; state: "busy" | "idle" | "limit" | "starting" };

export type UsageBoardBot = { botId: string; bot: string; busy: boolean };

export type UsageBoardAccount = {
  id: string;
  number: number;
  nickname: string | null;
  name: string;
  main: boolean;
  signIn: "ready" | "signing-in" | "signed-out" | "draining" | "unknown";
  // "complete": the report lists every window the plan enforces, so a missing session window means the plan has none.
  coverage: "complete" | "unknown";
  windows: UsageBoardWindow[];
  observedAt: number | null;
  history: { fine: UsageBoardSample[]; coarse: UsageBoardSample[] };
  bots: UsageBoardBot[];
  // null means unknown (host miss or old host), never "no workers".
  workers: UsageBoardRun[] | null;
  // Runs on the saved OpenAI key: no plan windows, never Main.
  credit?: true;
  codexPromo?: true;
};

export type UsageBoardEngine = {
  engine: UsageBoardEngineId;
  base: string;
  mainId: string;
  // Absent until automatic picks ship; true keeps new work on Main.
  stayOn?: boolean;
  accounts: UsageBoardAccount[];
  events: UsageBoardEvent[];
};

export type UsageBoard = {
  version: 1;
  revision: number;
  cursor: string;
  // false: history points and events are only the changed ones; upsert them.
  full: boolean;
  at: number;
  runs: "known" | "unknown" | "old-host";
  engines: UsageBoardEngine[];
};

export type UsageBoardFrame = { kind: "usage.board"; revision: number };
