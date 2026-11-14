import { describe, expect, it } from "vitest";
import { EFFORT_LEVELS } from "../server/contracts.ts";
import { BUILT_IN_DRIVERS } from "../server/drivers/builtIn.ts";
import { PICKER_MODEL_IDS } from "../src/lib/cross-model-picker.ts";
import { SKIN_IDS } from "../src/lib/skins.ts";
import { ERROR_CODES, ERROR_SITES } from "./error-report.mjs";
import { MODEL_INDEX_ENTRIES } from "./model-index-data.ts";
import {
  COUNT_STEPS, EFFORTS, ENGINES, EVENT_NAMES, FEATURES, MODELS, SCREENS, SETTINGS, SKINS, STATS_MAX_EVENTS,
  bucket, stackHash, statsBatchSchema, statsEnvelopeSchema, statsEventSchema, utcHour,
} from "./usage-stats.ts";

const h = utcHour(Date.UTC(2026, 10, 12, 13, 59));
const hex = (char: string) => char.repeat(32);

const SAMPLES: Record<(typeof EVENT_NAMES)[number], Record<string, unknown>> = {
  state: {
    e: "state", h,
    pc: { cores: 16, ramGb: 32, scale: 150, screens: 2 },
    ui: {
      skin: "precision", shape: "soft", pickerView: "dial", pickerLook: "follow", replyStyle: "paragraphs", chatBox: "rainbow",
      sidebar: "left", toolCalls: true, longerReplies: false, autoNotes: true, vibration: false, usageMode: "used", skinsTried: 3,
    },
    engines: [{ kind: "claudeAgent", accounts: 2, signedIn: true, cli: "2.1.90" }, { kind: "other", accounts: 0, signedIn: false }],
    counts: { bots: 8, rooms: 2, joinedRooms: 1, archived: 0, routines: 3, skills: 16, mcp: 4, phones: 1, pcs: 3 },
    on: { tailscale: true, relay: true, push: false, sync: true, syncChats: false, team: true, chief: false },
    keys: ["composio", "elevenlabs"],
  },
  launch: { e: "launch", h, cold: true, mainMs: 410, serverMs: 1200, windowMs: 1900, checksMs: 300, prevClean: true, prevMin: 60 },
  open: { e: "open", h, c: "phone", label: "notification", fcpMs: 320, mountMs: 500, helloMs: 640, chatMs: 900, cached: true },
  onboard: { e: "onboard", h, step: "signin", ms: 42_000, engine: "codex" },
  first_reply: { e: "first_reply", h, msStart: 180_000, msFinish: 9000, engine: "claudeAgent", model: "claude-opus-5-5", tries: 1 },
  turn: {
    e: "turn", h, c: "desktop", surface: "chat", engine: "claudeAgent", model: "claude-fable-5-2", effort: "high", ok: true, stop: "done",
    retries: 0, spawnMs: 120, readyMs: 800, ttftMs: 2100, doneMs: 40_000, reused: true, tools: 12, toolFails: 1, asks: 2, asksAuto: 1,
    denied: 0, tokIn: 52_000, tokOut: 1800, tokCached: 48_000, costUsd: 0.37, ctxPct: 26, images: 1, files: 0, len: 2, queued: false,
    resumed: true, compacted: false,
  },
  turn_error: { e: "turn_error", h, engine: "codex", model: "custom", kind: "retry", code: "rate_limited" },
  send: { e: "send", h, c: "browser", input: "voice", bubbleMs: 18, firstMs: 2400 },
  switch: { e: "switch", h, what: "model", via: "dial", ms: 35, from: "claude-opus-5-5", to: "gpt-6-astra" },
  screen: { e: "screen", h, c: "desktop", name: "settings-themes", n: 4 },
  setting: { e: "setting", h, c: "phone", key: "skin", from: "default", to: "tokyo-night", via: "settings" },
  feature: { e: "feature", h, c: "desktop", name: "attach.add", n: 2, kind: "pdf" },
  worker: { e: "worker", h, phase: "end", engine: "codex", model: "gpt-6-astra", effort: "auto", parallel: 4, outcome: "done", min: 15 },
  crash: { e: "crash", h, process: "renderer", kind: "renderer-gone", exit: -1073741819, stack: "0123456789ab", frame: "index-B1x2.js:12:345", up: 2, engine: "museAgent" },
  error: { e: "error", h, c: "desktop", site: "usageRefresh", code: "UNKNOWN_ERROR", stack: "ab0123456789", status: 503, n: 3 },
  stall: { e: "stall", h, c: "phone", where: "stream", ms: 5000, engine: "grokAgent", surface: "room" },
  update: { e: "update", h, phase: "installed", from: "1.0.255", to: "1.0.256", ms: 61_000 },
};

const envelope = {
  v: 1, id: hex("a"), batch: hex("b"), app: "1.0.256", channel: "stable", internal: false,
  os: "win32", osBuild: "10.0.26100", arch: "x64", lang: "en", osLang: "ko", dropped: 0,
};
const batch = (events: unknown[] = Object.values(SAMPLES), patch: Record<string, unknown> = {}) => ({ ...envelope, ...patch, events });

const PRIVATE = [
  "please summarize my divorce papers", "C:\\Users\\minsu\\secret.txt", "/home/minsu/.ssh/id_rsa", "minsu@example.com",
  "203.0.113.7", "2001:db8::1", "https://example.com/?token=abc", "DESKTOP-MINSU", "민수의 봇", "wkt1.abc.def",
];

type Path = (string | number)[];
function leaves(value: unknown, path: Path = []): { path: Path; value: unknown }[] {
  if (value === null || typeof value !== "object") return [{ path, value }];
  return Object.entries(value).flatMap(([key, child]) => leaves(child, [...path, Array.isArray(value) ? Number(key) : key]));
}
function objects(value: unknown, path: Path = []): Path[] {
  if (value === null || typeof value !== "object") return [];
  const below = Object.entries(value).flatMap(([key, child]) => objects(child, [...path, Array.isArray(value) ? Number(key) : key]));
  return Array.isArray(value) ? below : [path, ...below];
}
function patched(value: unknown, path: Path, next: unknown): unknown {
  if (path.length === 0) return next;
  const [key = "", ...rest] = path;
  // SAFETY: path comes from walking this same value.
  const copy = (Array.isArray(value) ? [...value] : { ...(value as object) }) as Record<string | number, unknown>;
  copy[key] = patched(copy[key], rest, next);
  return copy;
}

describe("events", () => {
  it("has 17 events and a sample for each", () => {
    expect(EVENT_NAMES).toHaveLength(17);
    expect(Object.keys(SAMPLES)).toEqual([...EVENT_NAMES]);
  });

  it.each(EVENT_NAMES)("accepts %s", (name) => {
    expect(statsEventSchema.safeParse(SAMPLES[name]).error?.issues).toBeUndefined();
  });

  it.each(EVENT_NAMES)("rejects private text in every string field of %s", (name) => {
    const strings = leaves(SAMPLES[name]).filter((leaf) => typeof leaf.value === "string");
    expect(strings.length).toBeGreaterThan(0);
    for (const { path } of strings) {
      for (const text of PRIVATE) {
        expect(statsEventSchema.safeParse(patched(SAMPLES[name], path, text)).success, `${path.join(".")} = ${text}`).toBe(false);
      }
    }
  });

  it.each(EVENT_NAMES)("rejects an unknown key at every level of %s", (name) => {
    for (const path of objects(SAMPLES[name])) {
      for (const [key, value] of [["note", "hello"], ["path", "C:\\Users\\minsu"], ["name", "minsu"], ["ip", "203.0.113.7"]]) {
        expect(statsEventSchema.safeParse(patched(SAMPLES[name], [...path, key ?? ""], value)).success, [...path, key].join(".")).toBe(false);
      }
    }
  });

  it.each(EVENT_NAMES)("rejects text where %s takes a number or a flag", (name) => {
    for (const { path, value } of leaves(SAMPLES[name])) {
      if (typeof value === "string") continue;
      expect(statsEventSchema.safeParse(patched(SAMPLES[name], path, "minsu@example.com")).success, path.join(".")).toBe(false);
    }
  });

  it("rejects values outside buckets and bounds", () => {
    const bad: [keyof typeof SAMPLES, Path, unknown][] = [
      ["state", ["pc", "ramGb"], 24], ["state", ["pc", "scale"], 110], ["state", ["pc", "cores"], 65], ["state", ["pc", "screens"], 4],
      ["state", ["counts", "bots"], 5], ["state", ["counts", "phones"], 10], ["state", ["ui", "skinsTried"], 100],
      ["state", ["engines", 0, "cli"], "2.1.90.4"], ["state", ["engines", 0, "accounts"], 10], ["state", ["keys"], ["composio", "notion"]],
      ["launch", ["prevMin"], 7], ["launch", ["mainMs"], -1], ["launch", ["mainMs"], 1.5], ["first_reply", ["tries"], 0],
      ["turn", ["costUsd"], 0.375], ["turn", ["ctxPct"], 101], ["turn", ["len"], 5], ["turn", ["images"], 21], ["turn", ["retries"], 10],
      ["turn", ["tools"], 1000], ["turn", ["h"], h + 0.5], ["worker", ["parallel"], 33], ["worker", ["min"], 20], ["crash", ["up"], 4],
      ["crash", ["stack"], "0123456789abcdef"], ["crash", ["frame"], "C:/Users/minsu/app.js:1:2"], ["crash", ["frame"], "index.js"],
      ["error", ["status"], 99], ["error", ["n"], 0], ["stall", ["ms"], 1500], ["update", ["to"], "1.0"], ["screen", ["n"], 0],
    ];
    for (const [name, path, value] of bad) {
      expect(statsEventSchema.safeParse(patched(SAMPLES[name], path, value)).success, `${name}.${path.join(".")} = ${String(value)}`).toBe(false);
    }
  });

  it("checks a setting's values against its own key", () => {
    const setting = SAMPLES.setting;
    expect(statsEventSchema.safeParse({ ...setting, key: "shape", from: "soft", to: "boxy" }).success).toBe(true);
    expect(statsEventSchema.safeParse({ ...setting, key: "toolCalls", from: "default", to: "off" }).success).toBe(true);
    expect(statsEventSchema.safeParse({ ...setting, key: "shape", from: "soft", to: "tokyo-night" }).success).toBe(false);
    expect(statsEventSchema.safeParse({ ...setting, key: "shape", from: "tokyo-night", to: "boxy" }).success).toBe(false);
    expect(statsEventSchema.safeParse({ ...setting, key: "skin", from: "default", to: "default" }).success).toBe(false);
    expect(statsEventSchema.safeParse({ ...setting, key: "analytics", from: "on", to: "off" }).success).toBe(false);
    expect(Object.keys(SETTINGS)).not.toContain("analytics");
  });

  it("checks a feature's kind against its own name", () => {
    const feature = SAMPLES.feature;
    expect(statsEventSchema.safeParse({ ...feature, name: "call.end", kind: undefined, ms: 61_000 }).success).toBe(true);
    expect(statsEventSchema.safeParse({ ...feature, name: "engine.signin", kind: "codex" }).success).toBe(true);
    expect(statsEventSchema.safeParse({ ...feature, name: "attach.add", kind: "docx" }).success).toBe(false);
    expect(statsEventSchema.safeParse({ ...feature, name: "room.create", kind: "pdf" }).success).toBe(false);
    for (const [name, kinds] of Object.entries(FEATURES)) {
      for (const kind of kinds) expect(statsEventSchema.safeParse({ e: "feature", h, c: "desktop", name, kind }).success, `${name} ${kind}`).toBe(true);
    }
  });

  it("accepts every screen, and no other name", () => {
    for (const name of SCREENS) expect(statsEventSchema.safeParse({ ...SAMPLES.screen, name }).success, name).toBe(true);
    expect(statsEventSchema.safeParse({ ...SAMPLES.screen, name: "settings-secret" }).success).toBe(false);
  });
});

describe("envelope", () => {
  it("accepts a full batch", () => {
    expect(statsBatchSchema.safeParse(batch()).error?.issues).toBeUndefined();
    expect(statsEnvelopeSchema.safeParse(batch()).success).toBe(true);
    expect(statsBatchSchema.safeParse(batch(undefined, { app: "1.0.257-dev.4", channel: "dev", internal: true, osLang: "other" })).success).toBe(true);
  });

  it("rejects private text in every string field", () => {
    for (const [key, value] of Object.entries(envelope)) {
      if (typeof value !== "string") continue;
      for (const text of PRIVATE) expect(statsBatchSchema.safeParse(batch(undefined, { [key]: text })).success, `${key} = ${text}`).toBe(false);
    }
  });

  it("rejects unknown keys, other versions and malformed fields", () => {
    for (const patch of [
      { label: "abcdefghijklmnop" }, { ip: "203.0.113.7" }, { account: "minsu@example.com" }, { hostname: "DESKTOP-MINSU" }, { tz: "Asia/Seoul" },
      { v: 2 }, { id: "A".repeat(32) }, { id: hex("a").slice(1) }, { batch: "not-a-batch" }, { app: "1.0" }, { osBuild: "10.0.26100.4652" },
      { osBuild: "203.0.113.7" }, { osLang: "en-US" }, { osLang: "KO" }, { lang: "ja" }, { channel: "beta" }, { internal: "yes" }, { dropped: -1 },
    ]) {
      expect(statsBatchSchema.safeParse(batch(undefined, patch)).success, JSON.stringify(patch)).toBe(false);
      expect(statsEnvelopeSchema.safeParse(batch(undefined, patch)).success, JSON.stringify(patch)).toBe(false);
    }
  });

  it("takes 1 to 2,000 events", () => {
    const screen = SAMPLES.screen;
    expect(statsBatchSchema.safeParse(batch([])).success).toBe(false);
    expect(statsBatchSchema.safeParse(batch(Array(STATS_MAX_EVENTS).fill(screen))).success).toBe(true);
    expect(statsBatchSchema.safeParse(batch(Array(STATS_MAX_EVENTS + 1).fill(screen))).success).toBe(false);
    expect(statsEnvelopeSchema.safeParse(batch(Array(STATS_MAX_EVENTS + 1).fill(screen))).success).toBe(false);
    expect(statsBatchSchema.safeParse(batch([screen, { e: "screen", h, c: "desktop", name: "chat", n: 1, title: "Tax return" }])).success).toBe(false);
  });
});

describe("lists", () => {
  it("cover what the app can pick, so a new id is added here before it ships", () => {
    expect([...SKINS]).toEqual([...SKIN_IDS, "other"]);
    expect([...EFFORTS]).toEqual([...EFFORT_LEVELS, "auto"]);
    expect(ENGINES).toEqual(expect.arrayContaining(BUILT_IN_DRIVERS.map((driver) => driver.driverKind)));
    // Hydrogen and Carbon wait for a relay deploy: the live relay drops events with a model it does not list, the app sends "custom".
    // TODO: when they join MODELS, ship the relay with them and drop `pending` and the not.toContain below.
    // Muse Ember has Model Index rows ahead of the picker; it joins MODELS with the picker.
    const pending = new Set(["gemini-4-hydrogen", "gemini-4-carbon", "muse-ember-1.0"]);
    expect(MODELS).toEqual(expect.arrayContaining([...PICKER_MODEL_IDS, ...MODEL_INDEX_ENTRIES.map((entry) => entry.model)].filter((id) => !pending.has(id))));
    expect(MODELS).not.toContain("gemini-4-hydrogen");
    expect(MODELS).not.toContain("gemini-4-carbon");
    for (const site of Object.keys(ERROR_SITES)) expect(statsEventSchema.safeParse({ ...SAMPLES.error, site }).success, site).toBe(true);
    for (const code of ERROR_CODES) expect(statsEventSchema.safeParse({ ...SAMPLES.error, code }).success, code).toBe(true);
  });

  it("hold only short coded words", () => {
    const words = [...SCREENS, ...SKINS, ...MODELS, ...ENGINES, ...EFFORTS, ...Object.keys(SETTINGS), ...Object.values(SETTINGS).flat(),
      ...Object.keys(FEATURES), ...Object.values(FEATURES).flat()];
    for (const word of words) expect(word).toMatch(/^[A-Za-z0-9][A-Za-z0-9.-]{0,31}$/);
  });
});

describe("bucket", () => {
  it("floors to the nearest step and never leaves the list", () => {
    expect([0, 1, 3, 4, 7, 8, 15, 16, 900].map((value) => bucket(value, COUNT_STEPS))).toEqual([0, 1, 3, 4, 4, 8, 8, 16, 16]);
    expect(bucket(-5, COUNT_STEPS)).toBe(0);
    expect(bucket(Number.NaN, COUNT_STEPS)).toBe(0);
  });

  it("keeps the UTC hour only", () => {
    expect(utcHour(Date.UTC(2026, 10, 12, 13, 0))).toBe(utcHour(Date.UTC(2026, 10, 12, 13, 59, 59)));
    expect(utcHour(Date.UTC(2026, 10, 12, 14, 0)) - h).toBe(1);
  });
});

describe("stackHash", () => {
  const stack = (home: string, message: string) => [
    `TypeError: ${message}`,
    `    at sendTurn (file:///${home}/AppData/Local/Programs/Wink/resources/app.asar/dist/assets/index-B1x2.js?v=9f3:812:19)`,
    `    at async Composer.submit (file:///${home}/AppData/Local/Programs/Wink/resources/app.asar/dist/assets/index-B1x2.js:97:5)`,
    "    at processTicksAndRejections (node:internal/process/task_queues:105:5)",
    `    at ${home}\\AppData\\Local\\Programs\\Wink\\resources\\app.asar\\node_modules\\zod\\index.js:4:2`,
  ].join("\n");

  it("hashes in-app frames without the path, the query or the message", () => {
    const a = stackHash(stack("C:/Users/minsu", "Cannot read 'divorce.pdf'"));
    const b = stackHash(stack("C:/Users/jiwoo", "Cannot read 'taxes.pdf'"));
    expect(a).toEqual(b);
    expect(a).toEqual({ stack: expect.stringMatching(/^[a-f0-9]{12}$/), frame: "index-B1x2.js:812:19" });
    expect(statsEventSchema.safeParse({ ...SAMPLES.crash, ...a }).success).toBe(true);
  });

  it("reads Safari and Firefox frames, on the phone", () => {
    const safari = stackHash("sendTurn@https://abcdefghijklmnop.wink.example/assets/index-B1x2.js:812:19\nsubmit@https://abcdefghijklmnop.wink.example/assets/index-B1x2.js:97:5");
    expect(safari?.frame).toBe("index-B1x2.js:812:19");
    expect(JSON.stringify(safari)).not.toContain("abcdefghijklmnop");
  });

  it("changes with the frames and is null without an in-app frame", () => {
    const a = stackHash(stack("C:/Users/minsu", "x"));
    const b = stackHash(stack("C:/Users/minsu", "x").replace("812:19", "813:19"));
    expect(a?.stack).not.toBe(b?.stack);
    expect(stackHash("Error: minsu@example.com\n    at node:internal/timers:1:1")).toBeNull();
    expect(stackHash("")).toBeNull();
  });
});
