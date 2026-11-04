// Fixture accounts for ACCT-TRADER-O. The same numbers in every crop and in the clip.
// Story: a busy morning burn (8:30 AM to 12:30 PM), then a quiet afternoon.
// Claude 2 was the pick; it ran out at 10:52 AM and Wink moved new work to Claude 1.
// "Now" is Wed Nov 4 2026, 3:12 PM in Seoul. Emails exist only for Connections rows.

export const ZONE = "Asia/Seoul";
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** "11-04 10:52" -> epoch ms in Seoul, 2026. */
export const at = (stamp: string): number => {
  const [date, time] = stamp.split(" ");
  return Date.parse(`2026-${date}T${time}:00+09:00`);
};

export const NOW = at("11-04 15:12");

export type EngineId = "claude" | "codex" | "grok" | "gemini";
export type Kind = "5h" | "week";
export type Key = readonly [stamp: string, used: number];
export type FxWindow = { kind: Kind; resetsAt: number; keys: readonly Key[] };
export type Worker = { name: string; initial: string; share: number };
export type FxAccount = {
  id: string;
  engine: EngineId;
  /** Stable tile number, given at sign-in and never reused. */
  n: number;
  email: string;
  nickname?: string;
  windows: FxWindow[];
  /** Who is on it right now. share = estimated % of this account's recent burn. */
  working: Worker[];
};
export type FxSwitch = { engine: EngineId; at: number; from: number; to: number; by: "auto" | "you" };

export const ENGINES: { id: EngineId; name: string; driverKind: string }[] = [
  { id: "claude", name: "Claude", driverKind: "claudeAgent" },
  { id: "codex", name: "Codex", driverKind: "codex" },
  { id: "grok", name: "Grok", driverKind: "grokAgent" },
  { id: "gemini", name: "Gemini", driverKind: "antigravityAgent" },
];

export const ACCOUNTS: FxAccount[] = [
  {
    id: "claude",
    engine: "claude",
    n: 1,
    email: "work@example.test",
    windows: [
      {
        kind: "5h",
        resetsAt: at("11-04 15:52"),
        keys: [["11-04 10:52", 0], ["11-04 11:05", 6], ["11-04 11:20", 15], ["11-04 11:40", 27], ["11-04 12:00", 38], ["11-04 12:15", 47], ["11-04 12:30", 55], ["11-04 12:50", 57], ["11-04 13:20", 59], ["11-04 13:50", 61], ["11-04 14:20", 63], ["11-04 14:45", 64.5], ["11-04 15:12", 66]],
      },
      {
        kind: "week",
        resetsAt: at("11-07 09:00"),
        keys: [["10-31 09:00", 0], ["10-31 14:00", 2], ["10-31 20:00", 3], ["11-01 15:00", 4], ["11-02 09:30", 4], ["11-02 13:00", 9], ["11-02 18:00", 14], ["11-03 10:00", 17], ["11-03 15:00", 23], ["11-03 20:00", 26], ["11-04 10:52", 26], ["11-04 11:40", 30], ["11-04 12:30", 36], ["11-04 13:30", 37], ["11-04 15:12", 39]],
      },
    ],
    working: [
      { name: "Atlas · build", initial: "A", share: 38 },
      { name: "Atlas · tests", initial: "A", share: 27 },
      { name: "Atlas", initial: "A", share: 21 },
      { name: "Mira", initial: "M", share: 14 },
    ],
  },
  {
    id: "acct_c2",
    engine: "claude",
    n: 2,
    email: "personal@example.test",
    nickname: undefined,
    windows: [
      {
        kind: "week",
        resetsAt: at("11-09 17:00"),
        keys: [["11-02 17:00", 0], ["11-02 21:00", 9], ["11-03 09:00", 14], ["11-03 13:00", 30], ["11-03 19:00", 55], ["11-04 08:30", 55], ["11-04 09:15", 68], ["11-04 10:00", 82], ["11-04 10:30", 93], ["11-04 10:52", 100], ["11-04 15:12", 100]],
      },
    ],
    working: [],
  },
  {
    id: "acct_c3",
    engine: "claude",
    n: 3,
    email: "studio@example.test",
    windows: [
      {
        kind: "5h",
        resetsAt: at("11-04 18:05"),
        keys: [["11-04 13:05", 0], ["11-04 13:30", 8], ["11-04 14:00", 17], ["11-04 14:30", 26], ["11-04 14:50", 33], ["11-04 15:12", 40]],
      },
      {
        kind: "week",
        resetsAt: at("11-10 20:00"),
        keys: [["11-03 20:00", 0], ["11-03 22:00", 3], ["11-04 13:05", 3], ["11-04 15:12", 9]],
      },
    ],
    working: [{ name: "Vega · docs", initial: "V", share: 100 }],
  },
  {
    id: "codex",
    engine: "codex",
    n: 1,
    email: "work@example.test",
    windows: [
      {
        // A weekly-only plan: no 5-hour window at all.
        kind: "week",
        resetsAt: at("11-05 14:29"),
        keys: [["10-29 14:29", 0], ["10-29 20:00", 6], ["10-30 18:00", 20], ["10-31 16:00", 24], ["11-01 16:00", 26], ["11-02 19:00", 42], ["11-03 19:00", 60], ["11-04 08:30", 60], ["11-04 10:00", 69], ["11-04 12:30", 78], ["11-04 14:00", 80], ["11-04 15:12", 82]],
      },
    ],
    working: [
      { name: "Juno · api", initial: "J", share: 46 },
      { name: "Juno", initial: "J", share: 31 },
      { name: "Orion · fix", initial: "O", share: 23 },
    ],
  },
  {
    id: "acct_x2",
    engine: "codex",
    n: 2,
    email: "team@example.test",
    windows: [
      {
        kind: "5h",
        resetsAt: at("11-04 17:40"),
        keys: [["11-04 12:40", 0], ["11-04 13:10", 12], ["11-04 13:40", 21], ["11-04 14:20", 30], ["11-04 14:50", 36], ["11-04 15:12", 40]],
      },
      {
        kind: "week",
        resetsAt: at("11-09 21:20"),
        keys: [["11-02 21:20", 0], ["11-03 11:00", 4], ["11-03 17:00", 8], ["11-04 12:40", 8], ["11-04 15:12", 14]],
      },
    ],
    working: [{ name: "Orion · review", initial: "O", share: 100 }],
  },
  {
    id: "grok",
    engine: "grok",
    n: 1,
    email: "work@example.test",
    windows: [],
    working: [],
  },
  {
    id: "antigravity",
    engine: "gemini",
    n: 1,
    email: "work@example.test",
    windows: [
      {
        kind: "5h",
        resetsAt: at("11-04 18:40"),
        keys: [["11-04 13:40", 0], ["11-04 13:55", 7], ["11-04 14:10", 12], ["11-04 15:12", 12]],
      },
      {
        kind: "week",
        resetsAt: at("11-06 10:00"),
        keys: [["10-30 10:00", 0], ["10-30 18:00", 6], ["11-02 15:00", 14], ["11-03 16:00", 25], ["11-04 14:10", 31], ["11-04 15:12", 31]],
      },
    ],
    working: [],
  },
];

/** The account each engine's new work goes to right now (Claude: moved by Wink). */
export const IN_USE: Record<EngineId, string> = { claude: "claude", codex: "codex", grok: "grok", gemini: "antigravity" };
/** The user's own pick (Main). Claude's pick ran out, so Wink is using 1 until 2 is back. */
export const MAIN: Record<EngineId, string> = { claude: "acct_c2", codex: "codex", grok: "grok", gemini: "antigravity" };

export const SWITCHES: FxSwitch[] = [{ engine: "claude", at: at("11-04 10:52"), from: 2, to: 1, by: "auto" }];

/** For the clip: Codex 1 keeps burning overnight and runs out Thu 8:31 AM, as its pace line said. */
export const CODEX_NEXT_MORNING: readonly Key[] = [["11-04 15:12", 82], ["11-04 19:00", 88], ["11-04 23:30", 91], ["11-05 07:30", 91], ["11-05 08:00", 95], ["11-05 08:31", 100]];
export const NEXT_MORNING = at("11-05 08:31");
