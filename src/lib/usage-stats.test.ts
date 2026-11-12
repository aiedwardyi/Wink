import { afterEach, describe, expect, it, vi } from "vitest";
import { statsEventSchema } from "../../shared/usage-stats";
import type { Action, AppState } from "../state/store-types";

type Batch = { events: Array<Record<string, unknown>>; ui?: Record<string, unknown>; lang?: string };
const POISON = ["C:\\Users\\dana\\secret plan.txt", "dana@example.com", "Dana Kim", "118234567890123456789", "10.0.0.7", "what is my salary"];
const settle = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function page({ capture = true, desktop = false, phone = false, status = 200 } = {}) {
  const posts: Batch[] = [];
  const inits: RequestInit[] = [];
  const heard = new Map<string, (event?: unknown) => void>();
  const stored = new Map<string, string>();
  const clock = { now: 0 };
  const state = { capture, status, tick: () => {}, longTask: (_list: { getEntries: () => Array<{ duration: number }> }) => {} };
  const document = {
    visibilityState: "visible", documentElement: { dataset: { locale: "ko" } },
    addEventListener: (name: string, run: () => void) => void heard.set(`document.${name}`, run),
  };
  const window = {
    ogb: desktop ? {} : undefined, document,
    requestIdleCallback: (run: () => void) => run(),
    setInterval: (run: () => void) => { state.tick = run; return 1; },
    addEventListener: (name: string, run: (event?: unknown) => void) => void heard.set(name, run),
  };
  const fetched = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/analytics") return { ok: true, status: 200, json: async () => ({ enabled: state.capture, capture: state.capture }) };
    posts.push(JSON.parse(String(init?.body)) as Batch);
    inits.push(init!);
    return { ok: state.status === 200, status: state.status };
  });
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("fetch", fetched);
  vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value) });
  vi.stubGlobal("requestAnimationFrame", (run: () => void) => { run(); return 1; });
  vi.stubGlobal("PerformanceObserver", class { constructor(run: typeof state.longTask) { state.longTask = run; } observe() {} });
  vi.spyOn(performance, "now").mockImplementation(() => clock.now);
  const stats = await import("./usage-stats");
  const ui = { skin: "precision", shape: "soft" };
  // SAFETY: the stub has every window member the module touches.
  stats.startUsageStats(() => ui, () => phone, window as unknown as Window);
  await settle();
  const events = () => posts.flatMap((batch) => batch.events);
  return { stats, posts, inits, heard, stored, clock, state, document, fetched, events, tick: async () => { state.tick(); await settle(); } };
}

describe("usage stats on a screen", () => {
  it("sends one keepalive batch a minute with the client, the look and the language", async () => {
    const { stats, posts, inits, tick, fetched } = await page({ desktop: true });
    stats.trackFeature("export");
    stats.trackUpdate("offered", "1.2.3");
    expect(posts).toEqual([]);
    await tick();
    expect(posts).toEqual([{
      events: [{ e: "feature", name: "export", c: "desktop" }, { e: "update", phase: "offered", to: "1.2.3" }],
      ui: { skin: "precision", shape: "soft" }, lang: "ko",
    }]);
    expect(inits[0]).toMatchObject({ method: "POST", keepalive: true });
    expect(fetched.mock.calls[1]![0]).toBe("/api/stats");
    await tick();
    expect(posts).toHaveLength(1);
    stats.trackFeature("export");
    await tick();
    expect(posts[1]).toEqual({ events: [{ e: "feature", name: "export", c: "desktop" }], lang: "ko" });
  });

  it.each([[true, "phone"], [false, "browser"]] as const)("names the client when there is no desktop shell (phone %s)", async (phone, c) => {
    const { stats, events, tick } = await page({ phone });
    stats.trackFeature("find.use");
    await tick();
    expect(events()[0]!.c).toBe(c);
  });

  it("keeps and sends nothing when this PC has stats off", async () => {
    const { stats, posts, heard, tick } = await page({ capture: false });
    stats.track({ e: "update", phase: "offered" });
    stats.trackScreen("chat");
    stats.trackFeature("export");
    stats.trackSetting("shape", "soft", "boxy");
    stats.trackSwitch("chat");
    stats.trackSend("t1");
    stats.trackReplyText("t1");
    await tick();
    heard.get("pagehide")!();
    await settle();
    expect(posts).toEqual([]);
    // Turned on later: nothing from the off time comes back.
    stats.usageStatsSwitched(true);
    await tick();
    expect(posts).toEqual([]);
  });

  it("sends nothing until the PC says the switch is on", async () => {
    const { stats, posts, state, heard, document, tick } = await page({ capture: false });
    state.capture = true;
    stats.trackFeature("export");
    await tick();
    expect(posts).toEqual([]);
    document.visibilityState = "visible";
    heard.get("document.visibilitychange")!();
    await settle();
    stats.trackFeature("export");
    await tick();
    expect(posts).toHaveLength(1);
  });

  it("stops and drops what it holds once the PC refuses a batch", async () => {
    const { stats, posts, state, tick } = await page();
    state.status = 409;
    stats.trackFeature("export");
    await tick();
    expect(posts).toHaveLength(1);
    stats.trackFeature("export");
    await tick();
    expect(posts).toHaveLength(1);
  });

  it("holds 500 events and drops the rest", async () => {
    const { stats, events, tick } = await page();
    for (let index = 0; index < 600; index++) stats.trackFeature("export");
    await tick();
    expect(events()).toHaveLength(500);
  });

  it("counts screens and sends them when the hour turns or the page hides", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 10, 12, 13, 10) });
    try {
      const { stats, events, heard, document, tick } = await page();
      stats.trackScreen("chat");
      stats.trackScreen("chat");
      stats.trackScreen("palette");
      await tick();
      expect(events()).toEqual([]);
      vi.setSystemTime(Date.UTC(2026, 10, 12, 14, 0));
      await tick();
      expect(events()).toEqual([{ e: "screen", name: "chat", n: 2, c: "browser" }, { e: "screen", name: "palette", n: 1, c: "browser" }]);
      stats.trackScreen("find");
      document.visibilityState = "hidden";
      heard.get("document.visibilitychange")!();
      await settle();
      expect(events()[2]).toEqual({ e: "screen", name: "find", n: 1, c: "browser" });
    } finally { vi.useRealTimers(); }
  });

  it("reports a setting's old and new value, and default for a first change", async () => {
    const { stats, stored, events, tick } = await page();
    stats.trackSetting("shape", "soft", "soft", "settings", "omb-shape");
    stats.trackSetting("shape", undefined, "soft", "settings", "omb-shape");
    stats.trackSetting("shape", "soft", "boxy", "settings", "omb-shape");
    stored.set("omb-shape", "boxy");
    stats.trackSetting("shape", "boxy", "soft", "settings", "omb-shape");
    stats.trackSetting("skin", "precision", "atelier", "hotkey");
    await tick();
    expect(events()).toEqual([
      { e: "setting", key: "shape", from: "default", to: "boxy", via: "settings", c: "browser" },
      { e: "setting", key: "shape", from: "boxy", to: "soft", via: "settings", c: "browser" },
      { e: "setting", key: "skin", from: "precision", to: "atelier", via: "hotkey", c: "browser" },
    ]);
  });

  it("times a chat switch to its paint and says where it came from", async () => {
    const { stats, clock, events, tick } = await page({ phone: true });
    vi.stubGlobal("requestAnimationFrame", (run: () => void) => { clock.now += 8; run(); return 1; });
    stats.trackSwitch("chat");
    stats.switchVia("palette");
    stats.trackSwitch("chat");
    stats.trackSwitch("model", "picker", "claude-opus-4-7", "claude-opus-4-7");
    stats.trackSwitch("model", "dial", "claude-opus-4-7", "gpt-5.5");
    await tick();
    expect(events()).toEqual([
      { e: "switch", what: "chat", via: "drawer", ms: 16 },
      { e: "switch", what: "chat", via: "palette", ms: 16 },
      { e: "switch", what: "model", via: "dial", from: "claude-opus-4-7", to: "gpt-5.5" },
    ]);
  });

  it("times a send to its bubble and to the first reply text of that chat", async () => {
    const { stats, clock, events, tick } = await page();
    const frames: Array<() => void> = [];
    vi.stubGlobal("requestAnimationFrame", (run: () => void) => { frames.push(run); return 1; });
    const paint = () => { for (const run of frames.splice(0)) run(); };
    stats.sendInput("call");
    stats.trackSend("t1");
    clock.now = 20;
    paint();
    paint();
    stats.trackReplyText("other");
    clock.now = 900;
    stats.trackReplyText("t1");
    paint();
    stats.trackReplyText("t1");
    stats.trackSend("t1");
    await tick();
    expect(events()).toEqual([{ e: "send", input: "call", bubbleMs: 20, firstMs: 900, c: "browser" }]);
  });

  it("holds first-run steps until the box is answered, then sends them", async () => {
    const { stats, posts, clock, events, tick } = await page({ capture: false });
    stats.trackOnboard("engine");
    stats.trackOnboard("welcome");
    clock.now = 4000;
    stats.trackOnboard("signin", "claudeAgent");
    await tick();
    expect(posts).toEqual([]);
    stats.trackOnboard("finish");
    stats.usageStatsSwitched(true);
    await settle();
    expect(events()).toEqual([
      { e: "onboard", step: "welcome", ms: 0 },
      { e: "onboard", step: "signin", ms: 4000, engine: "claudeAgent" },
      { e: "onboard", step: "finish", ms: 4000 },
    ]);
    stats.trackOnboard("commands");
    await tick();
    expect(events()).toHaveLength(3);
  });

  it("drops first-run steps when the box is unticked", async () => {
    const { stats, posts, tick } = await page({ capture: false });
    stats.trackOnboard("welcome");
    stats.trackOnboard("finish");
    stats.usageStatsSwitched(false);
    stats.usageStatsSwitched(true);
    await tick();
    expect(posts).toEqual([]);
  });

  it("reports an install's first reply once, with the sends it took", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1_000_000 });
    try {
      const { stats, stored, events, tick } = await page();
      const reply = () => ({ engine: "claudeAgent", model: "claude-opus-4-7" });
      stats.trackOnboard("welcome");
      vi.setSystemTime(1_030_000);
      stats.trackOnboard("finish");
      stats.trackSend("t1", reply);
      vi.setSystemTime(1_040_000);
      stats.trackSend("t1", reply);
      vi.setSystemTime(1_045_000);
      stats.trackReplyText("t1");
      stats.trackSend("t1", reply);
      stats.trackReplyText("t1");
      await tick();
      expect(events().filter((event) => event.e === "first_reply")).toEqual([
        { e: "first_reply", engine: "claudeAgent", model: "claude-opus-4-7", msStart: 45_000, msFinish: 15_000, tries: 2 },
      ]);
      expect(stored.get(stats.FIRST_REPLY_KEY)).toBe("done");
    } finally { vi.useRealTimers(); }
  });

  it("counts a stream that stays down 5 s on a visible page, and a 1 s long task", async () => {
    const { stats, clock, state, document, heard, events, tick } = await page();
    stats.trackStream(false);
    clock.now = 4000;
    stats.trackStream(true);
    stats.trackStream(false);
    clock.now = 10_500;
    stats.trackStream(false);
    stats.trackStream(true);
    document.visibilityState = "hidden";
    stats.trackStream(false);
    clock.now = 99_000;
    stats.trackStream(true);
    document.visibilityState = "visible";
    stats.trackStream(false);
    document.visibilityState = "hidden";
    heard.get("document.visibilitychange")!();
    document.visibilityState = "visible";
    clock.now = 199_000;
    stats.trackStream(true);
    state.longTask({ getEntries: () => [{ duration: 999 }, { duration: 1500.4 }] });
    await tick();
    expect(events()).toEqual([{ e: "stall", where: "stream", ms: 6500, c: "browser" }, { e: "stall", where: "ui", ms: 1500, c: "browser" }]);
  });

  it("sends an error as a site and a stack hash, never its message", async () => {
    const { heard, events, tick } = await page();
    const error = new Error(POISON[0]);
    error.stack = `Error: ${POISON[0]}\n    at render (http://127.0.0.1:5173/assets/index-abc.js:10:20)`;
    heard.get("error")!({ error });
    heard.get("error")!({});
    heard.get("unhandledrejection")!({ reason: POISON[1] });
    await vi.waitFor(async () => { await tick(); expect(events()).toHaveLength(2); });
    expect(events()).toEqual([
      { e: "error", site: "rendererError", code: "UNKNOWN_ERROR", stack: expect.stringMatching(/^[a-f0-9]{12}$/), c: "browser" },
      { e: "error", site: "rendererRejection", code: "UNKNOWN_ERROR", c: "browser" },
    ]);
  });

  it("passes the cold-open record through as an open event", async () => {
    const { stats, events, tick } = await page();
    stats.trackOpen({ label: "notification", firstContentfulPaint: 320.4, mount: 500, hello: 640, chatPaint: 900, cache: { hit: true } });
    stats.trackOpen({ label: "warm", chatPaint: 80 });
    await tick();
    expect(events()).toEqual([
      { e: "open", label: "notification", fcpMs: 320, mountMs: 500, helloMs: 640, chatMs: 900, cached: true, c: "browser" },
      { e: "open", label: "warm", chatMs: 80, c: "browser" },
    ]);
  });

  it("counts an update status once however many components watch it", async () => {
    const { stats, events, tick } = await page();
    for (const status of ["checking", "available", "available", "downloading", "error", "error"]) stats.trackUpdater(status, "1.4.0");
    await tick();
    expect(events()).toEqual([{ e: "update", phase: "offered", to: "1.4.0" }, { e: "update", phase: "failed", to: "1.4.0" }]);
  });

  it("builds only events the shared schema takes", async () => {
    const { stats, events, heard, tick } = await page();
    stats.trackOnboard("welcome");
    stats.usageStatsSwitched(true);
    stats.trackOpen({ label: "open", mount: 12 });
    stats.trackSend("t1", () => ({ engine: "claudeAgent", model: "claude-opus-5-5" }));
    stats.trackReplyText("t1");
    stats.trackSwitch("chat");
    stats.trackSwitch("effort", "picker", "low", "high");
    stats.trackScreen("settings-general");
    stats.trackSetting("language", "en", "ko");
    stats.trackFeature("call.end", { ms: 1200.6 });
    stats.trackFeature("approval.answer", { kind: "always" });
    stats.trackStream(false);
    stats.trackUpdate("clicked", "1.4.0");
    heard.get("pagehide")!();
    await tick();
    expect(events().map((event) => event.e).sort()).toEqual(["feature", "feature", "first_reply", "onboard", "open", "screen", "send", "setting", "switch", "switch", "update"]);
    for (const event of events()) expect(statsEventSchema.safeParse({ ...event, h: 1 }).error?.message, JSON.stringify(event)).toBeUndefined();
  });
});

describe("usage stats from store actions", () => {
  // SAFETY: only the fields trackAction reads; the rest of the app state is not needed here.
  const state = {
    selectedId: "b1", appSettingsOpen: false, appSettingsSection: "general", settingsOpen: false, inspectorOpen: false,
    bots: [{ id: "b1", name: POISON[2], threadId: "t1", autoApprove: false, modelSelection: { instanceId: "i1", model: "claude-opus-4-7", effort: "low" } }],
    groups: [{ id: "g1", name: POISON[0], threadId: "tg" }],
    instances: [{ instanceId: "i1", driverKind: "claudeAgent" }, { instanceId: "i2", driverKind: "codex" }],
  } as unknown as AppState;

  it("turns actions into events with ids and counts, never names or text", async () => {
    const { events, heard, tick } = await page();
    const { trackAction } = await import("./usage-stats-actions");
    const actions: Action[] = [
      { type: "select", id: "b1" },
      { type: "select", id: "g1" },
      { type: "send", botId: "b1", text: POISON[5]! },
      { type: "sendGroup", groupId: "g1", text: POISON[1]! },
      { type: "setModel", botId: "b1", selection: { instanceId: "i2", model: POISON[3]!, effort: "high" } },
      { type: "updateBot", botId: "b1", patch: { autoApprove: true, memoryNotes: false, hidden: true, name: POISON[2] } },
      { type: "toggleAppSettings", open: true, section: "themes" },
      { type: "toggleAppSettings", open: false },
      { type: "toggleSettings", open: true },
      { type: "toggleInspector", open: true },
      { type: "newBot" },
      { type: "createGroup", memberIds: ["b1", "b2"], name: POISON[0] },
      { type: "deleteBot", botId: "b1" },
      { type: "toggleReaction", threadId: "t1", messageId: "m1", emoji: "+1" },
      { type: "decideRequest", threadId: "t1", requestId: "r1", behavior: "allow", alwaysAllow: { botId: "b1", key: POISON[0]! } },
      { type: "decideRequest", threadId: "t1", requestId: "r1", behavior: "answer", message: POISON[5] },
      { type: "answerCard", botId: "b1", messageId: "m1", answer: POISON[5]! },
    ];
    for (const action of actions) trackAction(action, state);
    heard.get("pagehide")!();
    await tick();
    const sent = JSON.stringify(events());
    for (const poison of POISON.filter((text) => text !== POISON[3])) expect(sent).not.toContain(JSON.stringify(poison).slice(1, -1));
    expect(events()).toEqual([
      { e: "switch", what: "chat", via: "sidebar", ms: 0 },
      { e: "send", input: "typed", bubbleMs: 0, c: "browser" },
      { e: "switch", what: "engine", via: "picker", from: "claudeAgent", to: "codex" },
      // A model id the lists don't know becomes "custom" on the PC before anything is queued.
      { e: "switch", what: "model", via: "picker", from: "claude-opus-4-7", to: POISON[3] },
      { e: "switch", what: "effort", via: "picker", from: "low", to: "high" },
      { e: "setting", key: "approvals", from: "ask", to: "auto", via: "settings", c: "browser" },
      { e: "setting", key: "autoNotes", from: "on", to: "off", via: "settings", c: "browser" },
      { e: "feature", name: "bot.archive", c: "browser" },
      { e: "feature", name: "slot.open", kind: "details", c: "browser" },
      { e: "feature", name: "slot.open", kind: "inspector", c: "browser" },
      { e: "feature", name: "room.create", n: 2, c: "browser" },
      { e: "feature", name: "bot.delete", c: "browser" },
      { e: "feature", name: "reaction.add", c: "browser" },
      { e: "feature", name: "approval.answer", kind: "always", c: "browser" },
      { e: "feature", name: "question.answer", c: "browser" },
      { e: "feature", name: "question.answer", c: "browser" },
      { e: "send", input: "typed", bubbleMs: 0, c: "browser" },
      ...["room", "settings-themes", "details", "inspector", "new-bot"].map((name) => ({ e: "screen", name, n: 1, c: "browser" })),
    ]);
  });
});

describe("the look sent with usage stats", () => {
  it("is made of list values the schema takes", async () => {
    vi.stubGlobal("localStorage", { getItem: (key: string) => (key === "omb-picker-look" ? POISON[0] : null), setItem: () => {} });
    const { statsUi } = await import("./usage-stats-ui");
    const state = {
      e: "state", h: 1, pc: { cores: 8, ramGb: 16, scale: 100, screens: 1 }, engines: [],
      counts: { bots: 0, rooms: 0, joinedRooms: 0, archived: 0, routines: 0, skills: 0, mcp: 0, phones: 0, pcs: 1 },
      on: { tailscale: false, relay: false, push: false, sync: false, syncChats: false, team: false, chief: false }, keys: [],
    };
    expect(statsUi()).toMatchObject({ skin: "precision", shape: "soft", pickerLook: "follow", usageMode: "remaining", skinsTried: 0 });
    expect(statsEventSchema.safeParse({ ...state, ui: statsUi() }).error?.message).toBeUndefined();
  });
});
