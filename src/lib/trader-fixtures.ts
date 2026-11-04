import type { AppState, Bot, InstanceInfo } from "@/state/store-types";

export const DEMO_NOW = Date.parse("2026-11-05T15:00:00+09:00");

export interface AccountTraderMeta {
  instanceId: string;
  ticker: "C1" | "C2" | "C3" | "X1" | "X2" | "G1" | "M1";
  engineGroup: "claudeAgent" | "codex" | "grokAgent" | "antigravityAgent";
  engineLabel: string;
  slotIndex: number;
  email: string;
  burnRatePctPerHour: number;
  spendersEn: string;
  spendersKo: string;
  provenanceEn?: string;
  provenanceKo?: string;
  pinned?: boolean;
  weeklyOnly?: boolean;
}

export interface PaceSamplePoint {
  timeLabel: string;
  offsetHours: number;
  remainingPct: number;
  evenGuidePct: number;
  normal7dPct: number;
  accountTicker: "C1" | "C2";
  eventEn?: string;
  eventKo?: string;
}

// Morning burn (9:00 AM - 11:52 AM on C2 -> auto-switch C2->C1 -> quiet afternoon 12:40 PM - 3:00 PM)
export const CLAUDE_PACE_SAMPLES: PaceSamplePoint[] = [
  { timeLabel: "9:00a", offsetHours: -6.0, remainingPct: 92, evenGuidePct: 96, normal7dPct: 94, accountTicker: "C2" },
  { timeLabel: "9:45a", offsetHours: -5.25, remainingPct: 68, evenGuidePct: 90, normal7dPct: 86, accountTicker: "C2" },
  { timeLabel: "10:30a", offsetHours: -4.5, remainingPct: 41, evenGuidePct: 84, normal7dPct: 79, accountTicker: "C2" },
  { timeLabel: "11:15a", offsetHours: -3.75, remainingPct: 16, evenGuidePct: 78, normal7dPct: 72, accountTicker: "C2" },
  {
    timeLabel: "11:52a",
    offsetHours: -3.13,
    remainingPct: 0,
    evenGuidePct: 73,
    normal7dPct: 67,
    accountTicker: "C2",
    eventEn: "11:52 AM · C2 0% -> C1",
    eventKo: "오전 11:52 · C2 0% -> C1",
  },
  { timeLabel: "11:53a", offsetHours: -3.1, remainingPct: 100, evenGuidePct: 98, normal7dPct: 92, accountTicker: "C1" },
  { timeLabel: "12:40p", offsetHours: -2.33, remainingPct: 71, evenGuidePct: 86, normal7dPct: 81, accountTicker: "C1" },
  { timeLabel: "1:40p", offsetHours: -1.33, remainingPct: 69, evenGuidePct: 76, normal7dPct: 73, accountTicker: "C1" },
  { timeLabel: "2:20p", offsetHours: -0.67, remainingPct: 67.5, evenGuidePct: 65, normal7dPct: 65, accountTicker: "C1" },
  { timeLabel: "3:00p", offsetHours: 0, remainingPct: 66, evenGuidePct: 54, normal7dPct: 58, accountTicker: "C1" },
];

export const CLAUDE_PROJECTED_AT_RESET_PCT = 48;

export const DAILY_7D_BURN = [
  { dayEn: "Fri", dayKo: "금", usedPct: 62, leftPct: 38 },
  { dayEn: "Sat", dayKo: "토", usedPct: 44, leftPct: 56 },
  { dayEn: "Sun", dayKo: "일", usedPct: 38, leftPct: 62 },
  { dayEn: "Mon", dayKo: "월", usedPct: 85, leftPct: 15 },
  { dayEn: "Tue", dayKo: "화", usedPct: 74, leftPct: 26 },
  { dayEn: "Wed", dayKo: "수", usedPct: 68, leftPct: 32 },
  { dayEn: "Today", dayKo: "오늘", usedPct: 34, leftPct: 66, active: true },
];

export const TRADER_ACCOUNT_META: Record<string, AccountTraderMeta> = {
  claudeAgent: {
    instanceId: "claudeAgent",
    ticker: "C1",
    engineGroup: "claudeAgent",
    engineLabel: "Claude Code",
    slotIndex: 1,
    email: "aiedwardyi@gmail.com",
    burnRatePctPerHour: -4.8,
    spendersEn: "Kai · 3 workers (-4.8%/h)",
    spendersKo: "Kai · 워커 3개 (-4.8%/시간)",
    provenanceEn: "Moved from C2 · 11:52 AM",
    provenanceKo: "C2에서 자동 전환 · 오전 11:52",
  },
  "claudeAgent~2": {
    instanceId: "claudeAgent~2",
    ticker: "C2",
    engineGroup: "claudeAgent",
    engineLabel: "Claude Code",
    slotIndex: 2,
    email: "hitecledtx@gmail.com",
    burnRatePctPerHour: 0,
    spendersEn: "0 active · Out until Mon 5:00 PM",
    spendersKo: "활성 없음 · 월 오후 5:00 해제",
  },
  "claudeAgent~3": {
    instanceId: "claudeAgent~3",
    ticker: "C3",
    engineGroup: "claudeAgent",
    engineLabel: "Claude Code",
    slotIndex: 3,
    email: "getwinkdev@gmail.com",
    burnRatePctPerHour: -1.4,
    spendersEn: "1 worker · pinned (-1.4%/h)",
    spendersKo: "워커 1개 · 고정됨 (-1.4%/시간)",
    pinned: true,
  },
  codex: {
    instanceId: "codex",
    ticker: "X1",
    engineGroup: "codex",
    engineLabel: "Codex",
    slotIndex: 1,
    email: "edward@getwink.io",
    burnRatePctPerHour: -1.2,
    spendersEn: "2 workers (-1.2%/h)",
    spendersKo: "워커 2개 (-1.2%/시간)",
    weeklyOnly: true,
  },
  "codex~2": {
    instanceId: "codex~2",
    ticker: "X2",
    engineGroup: "codex",
    engineLabel: "Codex",
    slotIndex: 2,
    email: "ops@getwink.io",
    burnRatePctPerHour: 0,
    spendersEn: "Idle · Next in rotation",
    spendersKo: "대기 중 · 다음 순번",
  },
  grokAgent: {
    instanceId: "grokAgent",
    ticker: "G1",
    engineGroup: "grokAgent",
    engineLabel: "Grok",
    slotIndex: 1,
    email: "edward@x.ai",
    burnRatePctPerHour: 0,
    spendersEn: "Appears after your next Grok message.",
    spendersKo: "다음 Grok 메시지 후에 표시됩니다.",
  },
  antigravityAgent: {
    instanceId: "antigravityAgent",
    ticker: "M1",
    engineGroup: "antigravityAgent",
    engineLabel: "Gemini",
    slotIndex: 1,
    email: "edward.yi@google.com",
    burnRatePctPerHour: 0,
    spendersEn: "Gemini does not report a usage limit.",
    spendersKo: "Gemini는 사용 한도를 보고하지 않습니다.",
  },
};

export function createTraderFixtureInstances(now = DEMO_NOW, mainClaudeId: "claudeAgent" | "claudeAgent~3" = "claudeAgent"): InstanceInfo[] {
  const observedAt = new Date(now - 90_000).toISOString();
  const c1Reset5h = DEMO_NOW + (3 * 60 + 40) * 60_000;
  const c1Reset7d = Date.parse("2026-11-06T05:00:00+09:00");
  const c2Reset = Date.parse("2026-11-09T17:00:00+09:00");
  const c3Reset5h = DEMO_NOW + (2 * 60 + 15) * 60_000;
  const c3Reset7d = Date.parse("2026-11-10T11:00:00+09:00");
  const x1Reset7d = Date.parse("2026-11-11T15:30:00+09:00");
  const x2Reset5h = DEMO_NOW + (2 * 60 + 50) * 60_000;
  const x2Reset7d = Date.parse("2026-11-09T09:00:00+09:00");

  return [
    {
      instanceId: "claudeAgent",
      driverKind: "claudeAgent",
      displayName: "Claude Code",
      accountOf: "claudeAgent",
      accountMain: mainClaudeId === "claudeAgent",
      accountState: "ready",
      canRefreshUsage: true,
      access: "subscription",
      capabilities: {
        rateLimits: true,
      },
      models: { default: "claude-opus-4-6", options: [{ id: "claude-opus-4-6", label: "Opus 4.6" }] },
      snapshot: {
        state: "available",
        authenticated: true,
        account: "aiedwardyi@gmail.com",
        billing: "subscription",
      },
      rateLimits: {
        observedAt,
        windows: [
          { id: "five_hour", usedPercent: 34, windowMinutes: 300, resetsAt: c1Reset5h },
          { id: "seven_day", usedPercent: 61, windowMinutes: 10080, resetsAt: c1Reset7d },
        ],
      },
    },
    {
      instanceId: "claudeAgent~2",
      driverKind: "claudeAgent",
      displayName: "Claude Code",
      accountOf: "claudeAgent",
      accountMain: false,
      accountState: "ready",
      canRefreshUsage: true,
      access: "subscription",
      capabilities: {
        rateLimits: true,
      },
      models: { default: "claude-opus-4-6", options: [{ id: "claude-opus-4-6", label: "Opus 4.6" }] },
      snapshot: {
        state: "available",
        authenticated: true,
        account: "hitecledtx@gmail.com",
        billing: "subscription",
      },
      rateLimits: {
        observedAt,
        windows: [
          { id: "five_hour", usedPercent: 100, windowMinutes: 300, resetsAt: c2Reset },
          { id: "seven_day", usedPercent: 100, windowMinutes: 10080, resetsAt: c2Reset },
        ],
      },
    },
    {
      instanceId: "claudeAgent~3",
      driverKind: "claudeAgent",
      displayName: "Claude Code",
      accountOf: "claudeAgent",
      accountMain: mainClaudeId === "claudeAgent~3",
      accountState: "ready",
      canRefreshUsage: true,
      access: "subscription",
      capabilities: {
        rateLimits: true,
      },
      models: { default: "claude-opus-4-6", options: [{ id: "claude-opus-4-6", label: "Opus 4.6" }] },
      snapshot: {
        state: "available",
        authenticated: true,
        account: "getwinkdev@gmail.com",
        billing: "subscription",
      },
      rateLimits: {
        observedAt,
        windows: [
          { id: "five_hour", usedPercent: 60, windowMinutes: 300, resetsAt: c3Reset5h },
          { id: "seven_day", usedPercent: 28, windowMinutes: 10080, resetsAt: c3Reset7d },
        ],
      },
    },
    {
      instanceId: "codex",
      driverKind: "codex",
      displayName: "Codex",
      accountOf: "codex",
      accountMain: true,
      accountState: "ready",
      canRefreshUsage: true,
      access: "subscription",
      capabilities: {
        rateLimits: true,
      },
      models: { default: "gpt-5.3-codex", options: [{ id: "gpt-5.3-codex", label: "GPT-5.3 Codex" }] },
      snapshot: {
        state: "available",
        authenticated: true,
        account: "edward@getwink.io",
        billing: "subscription",
      },
      rateLimits: {
        observedAt,
        windows: [
          { id: "secondary", usedPercent: 18, windowMinutes: 10080, resetsAt: x1Reset7d },
        ],
      },
    },
    {
      instanceId: "codex~2",
      driverKind: "codex",
      displayName: "Codex",
      accountOf: "codex",
      accountMain: false,
      accountState: "ready",
      canRefreshUsage: true,
      access: "subscription",
      capabilities: {
        rateLimits: true,
      },
      models: { default: "gpt-5.3-codex", options: [{ id: "gpt-5.3-codex", label: "GPT-5.3 Codex" }] },
      snapshot: {
        state: "available",
        authenticated: true,
        account: "ops@getwink.io",
        billing: "subscription",
      },
      rateLimits: {
        observedAt,
        windows: [
          { id: "primary", usedPercent: 60, windowMinutes: 300, resetsAt: x2Reset5h },
          { id: "secondary", usedPercent: 36, windowMinutes: 10080, resetsAt: x2Reset7d },
        ],
      },
    },
    {
      instanceId: "grokAgent",
      driverKind: "grokAgent",
      displayName: "Grok",
      accountOf: "grokAgent",
      accountMain: true,
      accountState: "ready",
      canRefreshUsage: true,
      access: "subscription",
      capabilities: {
        rateLimits: true,
      },
      models: { default: "grok-4", options: [{ id: "grok-4", label: "Grok 4" }] },
      snapshot: {
        state: "available",
        authenticated: true,
        account: "edward@x.ai",
        billing: "subscription",
      },
      rateLimits: undefined,
    },
    {
      instanceId: "antigravityAgent",
      driverKind: "antigravityAgent",
      displayName: "Gemini",
      accountOf: "antigravityAgent",
      accountMain: true,
      accountState: "ready",
      canRefreshUsage: false,
      access: "subscription",
      capabilities: {
        rateLimits: false,
      },
      models: { default: "gemini-2.5-pro", options: [{ id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" }] },
      snapshot: {
        state: "available",
        authenticated: true,
        account: "edward.yi@google.com",
        billing: "subscription",
      },
      rateLimits: undefined,
    },
  ];
}

export function createTraderFixtureBots(): Bot[] {
  const baseBot = (
    id: string,
    name: string,
    color: Bot["color"],
    instanceId: string,
    turns: number,
    input: number,
    output: number,
    costUsd: number,
  ): Bot => ({
    id,
    threadId: `${id}-thread-1`,
    name,
    title: "Lead Engineer",
    description: "",
    notifications: true,
    color,
    unread: false,
    modelSelection: {
      instanceId,
      model: instanceId.startsWith("codex") ? "gpt-5.3-codex" : "claude-opus-4-6",
      mode: instanceId === "claudeAgent~3" ? "pinned" : "automatic",
    },
    tasks: [
      {
        threadId: `${id}-thread-1`,
        title: "Active workspace session",
        createdAt: DEMO_NOW - 7200_000,
        usage: {
          input,
          output,
          cachedInput: Math.round(input * 0.78),
          turns,
          costUsd,
        },
      },
    ],
    messages: [],
  });

  return [
    baseBot("bot-kai", "Kai", "coral", "claudeAgent", 42, 684_000, 38_400, 14.82),
    baseBot("bot-mira", "Mira (worker #1)", "cyan", "claudeAgent", 29, 412_000, 24_100, 9.15),
    baseBot("bot-sol", "Sol (worker #2)", "teal", "claudeAgent", 24, 318_000, 19_800, 7.04),
    baseBot("bot-ren", "Ren (pinned C3)", "yellow", "claudeAgent~3", 15, 194_000, 11_200, 4.18),
    baseBot("bot-dex", "Dex (Codex worker)", "purple", "codex", 19, 260_000, 15_900, 5.40),
  ];
}

export function createTraderFixtureAppState(
  now = DEMO_NOW,
  mainClaudeId: "claudeAgent" | "claudeAgent~3" = "claudeAgent",
): AppState {
  const bots = createTraderFixtureBots();
  return {
    bots,
    groups: [],
    instances: createTraderFixtureInstances(now, mainClaudeId),
    config: null,
    selectedId: bots[0]!.id,
    workspaceOpen: false,
    routines: [],
    routineRuns: [],
    createBotOpen: false,
    composerFocusBotId: null,
    settingsOpen: false,
    settingsAvatarRequest: 0,
    settingsKeepGoingRequest: 0,
    settingsMemoryTarget: null,
    settingsMemoryNonce: 0,
    pluginsOpen: false,
    inspectorOpen: false,
    appSettingsOpen: true,
    appSettingsSection: "usage",
    appSettingsPage: false,
    provisioning: {},
    focusMessage: null,
    connected: true,
    hydrated: true,
    error: null,
    mascotMotion: null,
    pendingQueued: {},
    consumedQueueIds: {},
    olderPatches: {},
    snapshots: 1,
    dismissedTaskRecovery: {},
    acceptedSends: {},
    stoppingBots: {},
    terminalAttention: {},
    terminalPanes: {},
    taskSwitches: {},
    branchChoices: {},
  };
}
