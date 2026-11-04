export const now = Date.parse("2026-11-05T15:00:00+09:00");
export const base = "ab89c492267e0d13a3bf2f867ad6a3db6fff452f";

const window = (id, left, reset, minutes) => ({
  id, usedPercent: 100 - left, resetsAt: Date.parse(reset), windowMinutes: minutes,
});
const five = (left, reset = "2026-11-05T18:40:00+09:00") => window("five_hour", left, reset, 300);
const week = (left, reset = "2026-11-06T05:00:00+09:00") => window("seven_day", left, reset, 10080);

export const accounts = [
  { id: "claude-1", engine: "Claude", tile: "1", main: true, windows: [five(66), week(39)], workers: ["Mina", "Review", "Tests"] },
  { id: "claude-2", engine: "Claude", tile: "2", out: true, windows: [week(0, "2026-11-09T17:00:00+09:00")], workers: [] },
  { id: "claude-3", engine: "Claude", tile: "3", windows: [five(40), week(74)], workers: ["Docs"] },
  { id: "codex-1", engine: "Codex", tile: "1", main: true, weeklyOnly: true, windows: [week(82, "2026-11-11T14:29:00+09:00")], workers: ["Kai", "Build"] },
  { id: "codex-2", engine: "Codex", tile: "2", windows: [five(40, "2026-11-05T17:50:00+09:00"), week(14, "2026-11-09T21:20:00+09:00")], workers: [] },
  { id: "grok-1", engine: "Grok", tile: "1", main: true, windows: [], workers: [] },
  { id: "gemini-1", engine: "Gemini", tile: "1", main: true, windows: [], workers: [] },
];

export const engines = ["Claude", "Codex", "Grok", "Gemini"];
export const history = [72, 71.2, 70.5, 69.5, 69, 68.2, 67.5, 66.8, 66];
export const trace = [
  [0, 70], [60, 35], [100, 0], [100, 100], [120, 86], [180, 38],
  [240, 15], [300, 8], [360, 2], [400, 0], [400, 100],
  ...history.map((remaining, index) => [420 + index * 7.5, remaining]),
];
export const hourly = [35, 49, 48, 23, 7, 6, 30, 6];
export const usual = [20, 24, 28, 24, 18, 16, 20, 12];
export const daily = [156, 131, 169, 146, 173, 148, 204];

export function instances() {
  const kinds = { Claude: "claudeAgent", Codex: "codex", Grok: "grokAgent", Gemini: "geminiAgent" };
  return accounts.map((account) => ({
    instanceId: account.id, accountOf: `${account.engine.toLowerCase()}-1`,
    accountState: "ready", accountMain: Boolean(account.main),
    driverKind: kinds[account.engine], displayName: account.engine,
    snapshot: { state: "available", authenticated: true, account: `${account.engine.toLowerCase()}${account.tile}@example.invalid` },
    capabilities: { rateLimits: true }, canRefreshUsage: false,
    models: { default: "fixture", options: [] },
    install: { login: { args: ["login"], deviceArgs: ["login", "--device"] } },
    rateLimits: account.windows.length ? { observedAt: new Date(now - 12000).toISOString(), windows: account.windows } : undefined,
  }));
}
