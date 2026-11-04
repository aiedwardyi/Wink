import type { UsageBoard, UsageBoardSample } from "./usage-board";

const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
export const usageBoardNow = at(4, 15);

const r1 = (value: number) => Math.round(value * 10) / 10;
const CLAUDE_2 = "acct_00000000-0000-4000-8000-000000000002";
const CLAUDE_3 = "acct_00000000-0000-4000-8000-000000000003";
const CODEX_2 = "acct_00000000-0000-4000-8000-000000000012";

// The 5h value climbs and resets every `period` points; the week climbs evenly to now.
function series(count: number, step: number, period: number, session: [number, number] | null, week: [number, number] | null) {
  const end = Math.floor(usageBoardNow / 60_000 / step) * step;
  return Array.from({ length: count }, (_, i): UsageBoardSample => {
    const back = count - 1 - i;
    const s = session && r1(session[1] - ((back % period) * (session[1] - session[0])) / (period - 1));
    const w = week && r1(week[0] + (i * (week[1] - week[0])) / (count - 1));
    return [end - back * step, s, w];
  });
}

// week: [7 days ago, 24 h ago, now]
const history = (session: [number, number] | null, week: [number, number, number] | null) => ({
  fine: series(288, 5, 60, session, week && [week[1], week[2]]),
  coarse: series(168, 60, 5, session, week && [week[0], week[2]]),
});

export const usageBoardFixture: UsageBoard = {
  version: 1,
  revision: 42,
  cursor: "fixture-42",
  full: true,
  at: usageBoardNow,
  runs: "known",
  engines: [
    {
      engine: "claude",
      base: "claude",
      mainId: "claude",
      stayOn: false,
      accounts: [
        {
          id: "claude",
          number: 1,
          nickname: null,
          name: "Claude 1",
          main: true,
          signIn: "ready",
          coverage: "complete",
          windows: [
            { id: "five_hour", kind: "session", usedPercent: 66, resetsAt: at(4, 15, 40), windowMinutes: 300 },
            { id: "seven_day", kind: "week", usedPercent: 41, resetsAt: at(6, 9), windowMinutes: 10080 },
          ],
          observedAt: usageBoardNow - 60_000,
          history: history([4, 66], [10, 33, 41]),
          bots: [
            { botId: "bot-atlas", bot: "Atlas", busy: true },
            { botId: "bot-mira", bot: "Mira", busy: false },
          ],
          workers: [
            { botId: "bot-atlas", bot: "Atlas", paneId: "pane-11", label: "ATLAS-1", state: "busy" },
            { botId: "bot-atlas", bot: "Atlas", paneId: "pane-12", label: "ATLAS-2", state: "idle" },
            { botId: "bot-mira", bot: "Mira", paneId: "pane-21", label: "MIRA-1", state: "starting" },
          ],
        },
        {
          id: CLAUDE_2,
          number: 2,
          nickname: null,
          name: "Claude 2",
          main: false,
          signIn: "ready",
          coverage: "unknown",
          windows: [{ id: "seven_day", kind: "week", usedPercent: 100, resetsAt: at(9, 17), windowMinutes: 10080 }],
          observedAt: usageBoardNow - 3 * 60_000,
          history: history(null, [62, 93, 100]),
          bots: [],
          workers: [{ botId: "bot-mira", bot: "Mira", paneId: "pane-22", label: "MIRA-2", state: "limit" }],
        },
        {
          id: CLAUDE_3,
          number: 3,
          nickname: "Studio",
          name: "Studio",
          main: false,
          signIn: "ready",
          coverage: "complete",
          windows: [
            { id: "five_hour", kind: "session", usedPercent: 60, resetsAt: at(4, 17, 10), windowMinutes: 300 },
            { id: "seven_day", kind: "week", usedPercent: 22, resetsAt: at(8, 11), windowMinutes: 10080 },
          ],
          observedAt: usageBoardNow - 2 * 60_000,
          history: history([8, 60], [3, 15, 22]),
          bots: [],
          workers: [],
        },
      ],
      events: [
        { seq: 7, at: at(4, 8, 31), kind: "limit", accountId: CLAUDE_2, window: "seven_day" },
        { seq: 8, at: at(4, 8, 31), kind: "auto", from: CLAUDE_2, to: "claude", paneId: "pane-12", label: "ATLAS-2" },
        { seq: 9, at: at(4, 8, 40), kind: "main", from: CLAUDE_2, to: "claude" },
        { seq: 10, at: at(4, 10, 40), kind: "reset", accountId: "claude", window: "five_hour" },
      ],
    },
    {
      engine: "codex",
      base: "codex",
      mainId: "codex",
      stayOn: false,
      accounts: [
        {
          id: "codex",
          number: 1,
          nickname: null,
          name: "Codex 1",
          main: true,
          signIn: "ready",
          coverage: "complete",
          windows: [{ id: "seven_day", kind: "week", usedPercent: 38, resetsAt: at(7, 21, 20), windowMinutes: 10080 }],
          observedAt: usageBoardNow - 60_000,
          history: history(null, [12, 31, 38]),
          bots: [{ botId: "bot-kai", bot: "Kai", busy: false }],
          workers: [{ botId: "bot-atlas", bot: "Atlas", paneId: "pane-13", label: "ATLAS-CX", state: "busy" }],
        },
        {
          id: CODEX_2,
          number: 2,
          nickname: null,
          name: "Codex 2",
          main: false,
          signIn: "ready",
          coverage: "complete",
          windows: [
            { id: "five_hour", kind: "session", usedPercent: 20, resetsAt: at(4, 18, 5), windowMinutes: 300 },
            { id: "seven_day", kind: "week", usedPercent: 55, resetsAt: at(10, 6), windowMinutes: 10080 },
          ],
          observedAt: usageBoardNow - 4 * 60_000,
          history: history([2, 20], [30, 50, 55]),
          bots: [],
          workers: [],
        },
      ],
      events: [{ seq: 6, at: at(3, 21, 20), kind: "main", from: CODEX_2, to: "codex" }],
    },
    {
      engine: "grok",
      base: "grok",
      mainId: "grok",
      accounts: [
        {
          id: "grok",
          number: 1,
          nickname: null,
          name: "Grok",
          main: true,
          signIn: "ready",
          coverage: "unknown",
          windows: [],
          observedAt: null,
          history: { fine: [], coarse: [] },
          bots: [],
          workers: [],
        },
      ],
      events: [],
    },
    {
      engine: "gemini",
      base: "gemini",
      mainId: "gemini",
      accounts: [
        {
          id: "gemini",
          number: 1,
          nickname: null,
          name: "Gemini",
          main: true,
          signIn: "ready",
          coverage: "complete",
          windows: [{ id: "daily", kind: "other", usedPercent: 18, resetsAt: at(5, 0), windowMinutes: 1440 }],
          observedAt: usageBoardNow - 2 * 60_000,
          history: { fine: [], coarse: [] },
          bots: [],
          workers: [],
        },
      ],
      events: [],
    },
  ],
};
