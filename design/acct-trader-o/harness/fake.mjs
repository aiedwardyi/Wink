// Fake Wink API for design shots. Same fixture accounts as the prototype (../fixtures.ts).
// No server, no ~/.orbit, no sign-in files: every /api call is answered here.
import { ACCOUNTS, IN_USE, NOW, MIN, at } from "../fixtures.ts";

const DRIVER = {
  claude: { driverKind: "claudeAgent", displayName: "Claude", model: "Opus 5.5" },
  codex: { driverKind: "codex", displayName: "Codex", model: "GPT-5.5" },
  grok: { driverKind: "grokAgent", displayName: "Grok", model: "Grok 5" },
  gemini: { driverKind: "antigravityAgent", displayName: "Gemini (Antigravity)", model: "Gemini 3.5 Pro" },
};
const windowId = (engine, kind) => (engine === "codex" ? (kind === "5h" ? "primary" : "secondary") : kind === "5h" ? "five_hour" : "seven_day");
const usedNow = (w) => w.keys.filter(([stamp]) => at(stamp) <= NOW).at(-1)?.[1] ?? 0;

export function instances() {
  return ACCOUNTS.map((a) => {
    const d = DRIVER[a.engine];
    const group = ACCOUNTS.filter((b) => b.engine === a.engine);
    const row = {
      instanceId: a.id, driverKind: d.driverKind, displayName: d.displayName,
      snapshot: { state: "available", authenticated: true, account: a.email },
      models: { default: "default", options: [{ id: "default", label: d.model }] },
      capabilities: { rateLimits: true }, canRefreshUsage: true,
      install: { login: { args: ["login"], deviceArgs: ["login", "--device"] }, logout: ["logout"], signInCommand: `${a.id} login` },
    };
    if (group.length > 1) Object.assign(row, { accountOf: group[0].id, accountState: "ready", accountMain: a.id === IN_USE[a.engine] });
    if (a.windows.length) {
      row.rateLimits = {
        observedAt: new Date(NOW - MIN).toISOString(),
        windows: a.windows.map((w) => ({ id: windowId(a.engine, w.kind), usedPercent: usedNow(w), windowMinutes: w.kind === "5h" ? 300 : 10080, resetsAt: w.resetsAt })),
      };
    }
    return row;
  });
}

let seq = 0;
const say = (role, text, minutesAgo) => ({ id: `m${++seq}`, role, kind: "text", text, at: NOW - minutesAgo * MIN });
const bot = (id, name, color, instanceId, messages, extra = {}) => ({
  id, threadId: `${id}-thread`, name, title: "", description: "", color, notifications: false, unread: false, busy: false,
  activity: "idle", hidden: false, pinned: false, autoApprove: true, browser: false,
  modelSelection: { instanceId, model: "default" }, messages, ...extra,
});

export function bots() {
  seq = 0;
  return [
    bot("atlas", "Atlas", "blue", "claude", [
      say("user", "Run the build and fix what breaks.", 14),
      say("bot", "The build passes now. Two tests were stale, so I updated them and reran the suite: 214 passed.", 11),
      say("user", "Ship the docs change too.", 6),
      say("bot", "Done. The docs build is clean and the preview link works.", 4),
    ]),
    bot("mira", "Mira", "purple", "claude", [say("user", "Draft the release notes.", 40), say("bot", "Draft is in notes/1.0.231.md.", 38)]),
    bot("juno", "Juno", "green", "codex", [say("user", "Profile the API cold start.", 25), say("bot", "Cold start is 1.8 s; most of it is the schema load.", 22)]),
    bot("orion", "Orion", "orange", "codex", [say("user", "Review the auth PR.", 30), say("bot", "Two notes left on the PR.", 28)]),
    bot("vega", "Vega", "teal", "claude", [say("user", "Tidy the docs site.", 60), say("bot", "Working on the nav now.", 58)]),
    bot("lyra", "Lyra", "coral", "acct_c2", [
      say("user", "Migrate the billing tables.", 262),
      { id: "w-limit", role: "bot", kind: "activity", at: at("11-04 10:52"), tool: {
        name: "error: You've hit your weekly limit · resets Nov 9, 5pm",
        usageLimit: { resetsAt: at("11-09 17:00") },
        usageWait: { id: "wait-1", ownerDeviceId: "desk", weekly: true, state: "waiting", resumesAt: at("11-09 17:00"), cancelable: true },
      } },
    ]),
    bot("nova", "Nova", "pink", "antigravity", [say("user", "Sketch three logo ideas.", 90), say("bot", "Three sketches are in the canvas.", 85)]),
  ];
}

export const config = {
  profile: { name: "Demo", email: "" }, composio: { configured: false }, gemini: { configured: false },
  box: { configured: false }, vps: { configured: false, sshAlias: "" }, rooms: { turnTimeoutMinutes: 10 },
  localVm: { mode: "shared", maxInstances: 1 }, features: { showToolCalls: false }, tts: { configured: false, ready: false },
  imageGen: { configured: true },
};

/** Answer one /api path. Unknown paths get an empty object, like an idle server. */
export function answer(path) {
  const rows = instances();
  if (path === "/api/bots") return { bots: bots(), groups: [], computerControl: {} };
  if (path === "/api/instances") return { instances: rows };
  if (path === "/api/config") return config;
  if (path === "/api/accounts") return { accounts: rows.filter((row) => row.accountOf).map((row) => ({ id: row.instanceId, of: row.accountOf, state: row.accountState, default: row.accountMain })) };
  if (path === "/api/analytics") return { enabled: false };
  if (path === "/api/devices") return { devices: [] };
  if (path === "/api/routines") return { routines: [], runs: [] };
  if (path === "/api/webhooks") return { webhooks: [], attempts: [], ingress: null };
  if (path === "/api/remote-link") return { url: null, setup: { state: "missing" } };
  if (path === "/api/phone/devices") return { phones: [] };
  if (path === "/api/key-uses") return { uses: {} };
  const thread = /^\/api\/bots\/([^/]+)\/messages/.exec(path);
  if (thread) return { messages: bots().find((b) => b.id === decodeURIComponent(thread[1]))?.messages ?? [], hasMore: false };
  if (path.includes("/messages")) return { messages: [], hasMore: false };
  return {};
}

/** Runs in the page before any app code: storage, a pinned clock, no live sockets. */
export function initScript({ phone, locale, skin, now }) {
  try {
    localStorage.clear();
    localStorage.setItem("omb-onboarding-done", "true");
    localStorage.setItem("omb-locale", locale);
    localStorage.setItem("omb-skin", skin);
  } catch {}
  const RealDate = Date;
  const t0 = performance.now();
  const clock = () => now + (performance.now() - t0);
  class PinnedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(clock());
      else super(...args);
    }
    static now() { return clock(); }
  }
  window.Date = PinnedDate;
  if (!phone) window.ogb = { platform: "win32", openExternal: async () => true, errorReportConsent: async () => true, setErrorReportConsent: async (value) => value };
  window.EventSource = class {
    constructor() {
      this.readyState = 0;
      this.timer = setTimeout(() => {
        this.readyState = 1;
        this.onopen?.();
        this.onmessage?.({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c1" }), lastEventId: "" });
      }, 40);
    }
    close() { this.readyState = 2; clearTimeout(this.timer); }
    addEventListener() {}
    removeEventListener() {}
  };
  try { navigator.clipboard.writeText = async () => {}; } catch {}
}
