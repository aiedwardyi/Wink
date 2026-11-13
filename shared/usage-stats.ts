// Anonymous usage stats, shared by the app, its server and the relay. Every string is a word
// from a list in this file or a shape-checked code, so nothing a person typed can pass.

import { z } from "zod";
import { ERROR_CODES, ERROR_SITES } from "./error-report.mjs";

export const STATS_MAX_EVENTS = 2000;
export const STATS_MAX_BYTES = 256 * 1024;
export const STATS_MAX_INFLATED = 2 * 1024 * 1024;

export const RAM_STEPS = [4, 8, 16, 32, 64, 128] as const;
export const SCALE_STEPS = [100, 125, 150, 175, 200, 250, 300] as const;
export const COUNT_STEPS = [0, 1, 2, 3, 4, 8, 16] as const;
export const MINUTE_STEPS = [0, 1, 5, 15, 60, 240, 600] as const;
export const STALL_STEPS = [1000, 2000, 5000, 10_000, 30_000, 60_000] as const;

/** The largest step at or under `value`; the first step when none is. */
export function bucket(value: number, steps: readonly number[]): number {
  let out = steps[0] ?? 0;
  for (const step of steps) if (value >= step) out = step;
  return out;
}

export const utcHour = (ms: number) => Math.floor(ms / 3_600_000);

// Copies of src/lib/skins.ts, server/contracts.ts, the driver registry and the model lists: usage-stats.test.ts fails when one grows.
export const SKINS = [
  "wink", "wink-cyber", "wink-violet", "wink-black", "wink-day", "midnight", "atelier", "foundry", "lagoon", "ledger",
  "catppuccin-frappe", "tokyo-night", "vesper", "onyx", "peach", "coral", "dracula", "cobalt", "gruvbox", "kanagawa",
  "hurtado", "rose-pine", "nord", "github-dimmed", "tui", "tui-black", "tui-amber", "tui-ice", "tui-slate", "tui-smoke",
  "terminal", "terminal-dracula", "terminal-ice", "paper-tape", "logfile", "multiplexer", "modal", "vscode-dark", "studio-gray", "steel-gray",
  "claude", "precision", "mono-hud", "servo-gray", "notebook", "messenger", "community", "community-light", "code-review", "blueprint",
  "blueprint-gray", "blueprint-charcoal", "instrument", "matte", "carbon", "pewter", "pewter-dusk", "pewter-night", "coal", "folio",
  "inkwell", "graphite", "merlot", "precision-dimmed", "bronze", "dim-sand",
  "other",
] as const;
export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "auto"] as const;
export const ENGINES = ["claudeAgent", "codex", "grokAgent", "museAgent", "antigravityAgent", "boxAgent", "other"] as const;
export const MODELS = [
  "claude-fable-5-2", "claude-fable-5-1", "claude-fable-5", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5",
  "gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna", "gpt-5.6-terra", "grok-4.7", "grok-4.6",
  "muse-spark-1.3", "muse-spark-1.3-contributor", "gemini-4-argon", "gemini-3.8-flash",
  "custom",
] as const;

export const SCREENS = [
  "chat", "room", "room-setup", "members", "room-instructions", "sidebar-search", "new-menu", "new-bot", "new-room", "find",
  "model-picker", "model-dial", "model-chart", "workers", "terminal", "remote-terminal", "details", "memory", "avatar",
  "settings-account", "settings-general", "settings-advanced", "settings-connections", "settings-themes", "settings-more-themes",
  "settings-shortcuts", "settings-devices", "settings-usage", "settings-team", "settings-model-index", "settings-sync",
  "palette", "inspector", "watch", "usage-quick", "teams-library", "archived", "call", "live-call", "room-alerts",
  "message-menu", "attachment-preview", "no-engines", "whats-new",
] as const;

const FLAG = ["on", "off"] as const;
/** Each setting with the values it can take. `from` may also be "default". */
export const SETTINGS = {
  skin: SKINS, shape: ["soft", "boxy"], pickerView: ["dial", "list", "chart", "machine"], pickerLook: ["follow", "dark", "light", "atelier"],
  replyStyle: ["paragraphs", "live"], chatBox: ["off", "rainbow", "theme"], sidebarSide: ["left", "right"],
  toolCalls: FLAG, longerReplies: FLAG, autoNotes: FLAG, vibration: FLAG, language: ["en", "ko"], usageMode: ["used", "remaining"],
  terminalAlerts: FLAG, phoneNotifications: FLAG, approvals: ["auto", "ask"], syncChats: FLAG, phoneAccess: FLAG,
} as const satisfies Record<string, readonly string[]>;

const NONE: readonly string[] = [];
/** Each feature with the `kind` values it can carry. */
export const FEATURES = {
  "room.create": NONE, "room.join": NONE, "room.leave": NONE, "voice.dictate": NONE, "call.start": ["bot", "room"], "call.end": NONE,
  "phone.pair": NONE, "phone.unpair": NONE, "push.on": NONE, "terminal.open": NONE, "terminal.type": NONE,
  "watch.open": ["live", "replay"], "slot.open": ["watch", "details", "inspector"], "palette.run": ["bot", "room", "message", "inspector"],
  "memory.edit": NONE, "memory.clean": NONE, "find.use": NONE, "reaction.add": NONE, "attach.add": ["image", "pdf", "text", "other"],
  "teams.import": NONE, "skill.install": NONE, "chief.set": NONE, "routine.run": NONE, "sync.on": NONE, "sync.off": NONE, export: NONE,
  "usage.refresh": NONE, "approval.answer": ["allow", "deny", "always"], "question.answer": NONE,
  "bot.create": NONE, "bot.archive": NONE, "bot.delete": NONE, "engine.connect": ENGINES, "engine.signin": ENGINES, "star.click": NONE,
} as const satisfies Record<string, readonly string[]>;

const ERROR_KINDS = [
  "missing_cli", "invalid_credentials", "inactive_subscription", "quota_or_region_restriction", "upstream_outage", "model_catalog_outage",
  "rate_limited", "overloaded", "server_error", "connection_reset", "timeout", "auth", "quota", "unknown_model", "invalid_request",
  "not_found", "terminal_exit", "interrupted", "unknown", "other",
] as const;

const FRAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}\.(?:[cm]?js|tsx?):\d{1,7}:\d{1,7}$/;
const count = (max: number, min = 0) => z.int().min(min).max(max);
const h = count(3_000_000);
const ms = count(7 * 86_400_000);
const tokens = count(1_000_000_000);
const flag = z.boolean();
const client = z.enum(["desktop", "phone", "browser"]);
const engine = z.enum(ENGINES);
const model = z.enum(MODELS);
const effort = z.enum(EFFORTS);
const surface = z.enum(["chat", "room", "worker", "routine", "quick", "verify"]);
const version = z.string().regex(/^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-(?:dev|alpha|beta|rc)\.\d{1,12})?$/);
const stack = z.string().regex(/^[a-f0-9]{12}$/);
const hex32 = z.string().regex(/^[a-f0-9]{32}$/);
const word = z.string().max(32);
const has = (list: readonly string[], value: string) => list.includes(value);

const event = <N extends string, S extends z.ZodRawShape>(name: N, shape: S) => z.strictObject({ e: z.literal(name), h, ...shape });

export const statsEventSchema = z.discriminatedUnion("e", [
  event("state", {
    pc: z.strictObject({ cores: count(64, 1), ramGb: z.literal(RAM_STEPS), scale: z.literal(SCALE_STEPS), screens: count(3, 1) }),
    ui: z.strictObject({
      skin: z.enum(SKINS), shape: z.enum(SETTINGS.shape), pickerView: z.enum(SETTINGS.pickerView), pickerLook: z.enum(SETTINGS.pickerLook),
      replyStyle: z.enum(SETTINGS.replyStyle), chatBox: z.enum(SETTINGS.chatBox), sidebar: z.enum(SETTINGS.sidebarSide),
      toolCalls: flag, longerReplies: flag, autoNotes: flag, vibration: flag, usageMode: z.enum(SETTINGS.usageMode), skinsTried: count(99),
    }).partial().optional(),
    engines: z.array(z.strictObject({ kind: engine, accounts: count(9), signedIn: flag, cli: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,5}$/).optional() })).max(16),
    counts: z.strictObject({
      bots: z.literal(COUNT_STEPS), rooms: z.literal(COUNT_STEPS), joinedRooms: z.literal(COUNT_STEPS), archived: z.literal(COUNT_STEPS),
      routines: z.literal(COUNT_STEPS), skills: z.literal(COUNT_STEPS), mcp: z.literal(COUNT_STEPS), phones: count(9), pcs: count(9),
    }),
    on: z.strictObject({ tailscale: flag, relay: flag, push: flag, sync: flag, syncChats: flag, team: flag, chief: flag }),
    keys: z.array(z.enum(["composio", "elevenlabs", "assemblyai", "xai", "box", "openai-images", "custom-provider"])).max(7),
  }),
  event("launch", {
    cold: flag, mainMs: ms.optional(), serverMs: ms.optional(), windowMs: ms.optional(), checksMs: ms.optional(),
    prevClean: flag.optional(), prevMin: z.literal(MINUTE_STEPS).optional(),
  }),
  event("open", {
    c: client, label: z.enum(["open", "notification", "warm", "resume"]),
    fcpMs: ms.optional(), mountMs: ms.optional(), helloMs: ms.optional(), chatMs: ms.optional(), cached: flag.optional(),
  }),
  event("onboard", { step: z.enum(["welcome", "engine", "commands", "installing", "signin", "ready", "finish"]), ms, engine: engine.optional() }),
  event("first_reply", { msStart: ms.optional(), msFinish: ms.optional(), engine, model, tries: count(9, 1) }),
  event("turn", {
    c: z.enum(["desktop", "phone", "browser", "voice", "system"]), surface, engine, model, effort, ok: flag,
    stop: z.enum(["done", "interrupted", "error", "usage-limit", "signed-out", "timeout", "superseded"]),
    retries: count(9).optional(), spawnMs: ms.optional(), readyMs: ms.optional(), ttftMs: ms.optional(), doneMs: ms.optional(),
    reused: flag.optional(), tools: count(999).optional(), toolFails: count(999).optional(), asks: count(999).optional(),
    asksAuto: count(999).optional(), denied: count(999).optional(), tokIn: tokens.optional(), tokOut: tokens.optional(),
    tokCached: tokens.optional(), costUsd: z.number().min(0).max(100_000).refine((usd) => Math.round(usd * 100) / 100 === usd).optional(),
    ctxPct: count(100).optional(), images: count(20).optional(), files: count(20).optional(), len: count(4).optional(),
    queued: flag.optional(), resumed: flag.optional(), compacted: flag.optional(),
  }),
  event("turn_error", {
    engine, model: model.optional(), kind: z.enum(["setup", "sign-in", "signed-out", "usage-limit", "runtime", "retry", "crash"]), code: z.enum(ERROR_KINDS),
  }),
  event("send", { c: client, input: z.enum(["typed", "voice", "call"]), bubbleMs: ms.optional(), firstMs: ms.optional() }),
  event("switch", {
    what: z.enum(["chat", "model", "effort", "engine"]), via: z.enum(["sidebar", "drawer", "palette", "hotkey", "picker", "dial", "settings"]),
    ms: ms.optional(), from: z.enum([...ENGINES, ...MODELS, ...EFFORTS]).optional(), to: z.enum([...ENGINES, ...MODELS, ...EFFORTS]).optional(),
  }),
  event("screen", { c: client, name: z.enum(SCREENS), n: count(100_000, 1) }),
  // SAFETY: Object.keys of a const object literal is exactly its keys.
  event("setting", {
    c: client, key: z.enum(Object.keys(SETTINGS) as [keyof typeof SETTINGS]), from: word, to: word,
    via: z.enum(["settings", "picker", "hotkey", "onboarding", "palette", "menu"]),
  }).refine((set) => has(SETTINGS[set.key], set.to) && (set.from === "default" || has(SETTINGS[set.key], set.from))),
  // SAFETY: Object.keys of a const object literal is exactly its keys.
  event("feature", {
    c: client, name: z.enum(Object.keys(FEATURES) as [keyof typeof FEATURES]), n: count(100_000).optional(), ms: ms.optional(), kind: word.optional(),
  }).refine((use) => use.kind === undefined || has(FEATURES[use.name], use.kind)),
  event("worker", {
    phase: z.enum(["start", "end"]), engine, model, effort, parallel: count(32, 1),
    outcome: z.enum(["done", "failed", "stuck", "stopped"]).optional(), min: z.literal(MINUTE_STEPS).optional(),
  }),
  event("crash", {
    process: z.enum(["main", "renderer", "server", "engine"]),
    kind: z.enum(["unclean-exit", "renderer-gone", "server-gone", "startup-timeout", "uncaught", "oom"]),
    exit: count(2_147_483_647, -2_147_483_648).optional(), stack: stack.optional(), frame: z.string().regex(FRAME_RE).optional(),
    up: count(3).optional(), engine: engine.optional(),
  }),
  event("error", {
    c: client.optional(), site: z.enum(Object.keys(ERROR_SITES)), code: z.enum(ERROR_CODES), stack: stack.optional(),
    status: count(599, 100).optional(), n: count(100_000, 1).optional(),
  }),
  event("stall", {
    c: client.optional(), where: z.enum(["ui", "server", "engine", "stream"]), ms: z.literal(STALL_STEPS), engine: engine.optional(), surface: surface.optional(),
  }),
  event("update", { phase: z.enum(["offered", "clicked", "installed", "failed"]), from: version.optional(), to: version.optional(), ms: ms.optional() }),
]);
export type StatsEvent = z.infer<typeof statsEventSchema>;

export const EVENT_NAMES = [
  "state", "launch", "open", "onboard", "first_reply", "turn", "turn_error", "send", "switch",
  "screen", "setting", "feature", "worker", "crash", "error", "stall", "update",
] as const satisfies readonly StatsEvent["e"][];

const envelope = {
  v: z.literal(1), id: hex32, batch: hex32, app: version, channel: z.enum(["stable", "dev"]), internal: flag,
  os: z.enum(["win32", "darwin", "linux"]), osBuild: z.string().regex(/^\d{1,5}(?:\.\d{1,5}){0,2}$/), arch: z.enum(["x64", "arm64", "ia32", "arm"]),
  lang: z.enum(["en", "ko"]), osLang: z.string().regex(/^(?:[a-z]{2}|other)$/), dropped: count(1_000_000),
};
/** The batch without its events checked: the relay keeps the events it knows and drops the rest. */
export const statsEnvelopeSchema = z.strictObject({ ...envelope, events: z.array(z.unknown()).min(1).max(STATS_MAX_EVENTS) });
export const statsBatchSchema = z.strictObject({ ...envelope, events: z.array(statsEventSchema).min(1).max(STATS_MAX_EVENTS) });
export type StatsBatch = z.infer<typeof statsBatchSchema>;

const V8_FRAME = /^\s*at (?:(.*?) \()?(.+?):(\d+):(\d+)\)?$/;
const JSC_FRAME = /^(.*?)@(.+?):(\d+):(\d+)$/;

/** FNV-1a 64 of the in-app frames as `file:line:col fn`, and the top one. Paths, queries and the message never enter. */
export function stackHash(trace: string): { stack: string; frame: string } | null {
  const frames: string[] = [];
  for (const line of trace.split("\n").slice(0, 200)) {
    const match = V8_FRAME.exec(line) ?? JSC_FRAME.exec(line.trim());
    if (!match) continue;
    const [, fn = "", url = "", row, col] = match;
    if (url.startsWith("node:") || url.includes("node_modules")) continue;
    const at = `${url.replace(/[?#].*$/, "").split(/[\\/]/).pop()}:${row}:${col}`;
    if (FRAME_RE.test(at)) frames.push(`${at} ${fn}`);
  }
  const top = frames[0]?.split(" ")[0];
  if (!top) return null;
  let hash = 0xcbf29ce484222325n;
  for (const char of frames.join("\n")) hash = BigInt.asUintN(64, (hash ^ BigInt(char.codePointAt(0) ?? 0)) * 0x100000001b3n);
  return { stack: hash.toString(16).padStart(16, "0").slice(0, 12), frame: top };
}
