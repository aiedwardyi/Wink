import { describe, expect, it, vi } from "vitest";

import type { PrepareTurn, SendTurnInput } from "./contracts.ts";
import { canServeTurn, warmToolsKey } from "./drivers/acp/warm-eligibility.ts";
import type { BundledSkill } from "./skill-library.ts";
import {
  approvalDescriptor,
  connectedAppsDescriptor,
  cwdDescriptor,
  dryShape,
  modelDescriptor,
  phoneDescriptor,
  resumeDescriptor,
  turnDescriptor,
  type Cached,
  type DryTurnDeps,
  type DryTurnState,
  type TurnInstance,
  type ToolDescriptor,
  type TurnDepth,
  type TurnDescriptorInput,
} from "./turn-shape.ts";

const tool = (name: string): ToolDescriptor => ({ command: "node", args: [`${name}-proxy.js`], env: { BOT: "atlas" } });
const cached = <T>(value: T): Cached<T> => ({ value });
const phoneSkill: BundledSkill = {
  directory: "/fake/skills/phone",
  instructions: "Use the phone tools.",
  manifest: {
    id: "phone",
    name: "Phone",
    version: "1.0.0",
    description: "Phone tools",
    defaultEnabled: true,
    triggerTerms: ["phone", "휴대폰"],
    requiredCapabilities: ["phoneMcp"],
  },
};

function fixture() {
  const instance: TurnInstance = {
    instanceId: "grok-main",
    driverKind: "grokAgent",
    models: { default: "grok-4.6", options: [{ id: "grok-4.6", label: "Grok 4.6" }] },
    adapter: {
      capabilities: {
        sessionModelSwitch: "in-session",
        effortLevels: ["low", "high", "xhigh"],
        agentsMcp: true,
        composioMcp: true,
        phoneMcp: true,
      },
    },
  };
  const live: TurnDescriptorInput = {
    bot: { id: "atlas", computer: "off" },
    threadId: "thread-1",
    instance,
    selection: { instanceId: instance.instanceId, model: "grok-4.6", effort: "high" },
    captured: { generation: 4, incarnation: "grok-main-1", identity: "fake-auth-hash" },
    depth: 0,
    folder: {
      privateWorkspace: "C:\\fake\\workspaces\\atlas",
      taskCwd: undefined,
      botCwd: "D:\\fake\\project",
      resolvedProject: undefined,
      resumeCursors: {},
    },
    cursor: { cursor: undefined, resume: true, rewound: false, recycle: false, sessionKind: "session" },
    tools: {
      text: "Please explain this function",
      skills: [phoneSkill],
      terminal: tool("terminal"),
      phone: tool("phone"),
      connectedApps: { configured: true, connection: tool("connected-apps") },
      dwebUrl: null,
      otherIntegrations: {},
    },
  };
  const state: DryTurnState = {
    room: cached(false),
    selection: cached(live.selection),
    captured: cached(live.captured),
    folder: cached(live.folder),
    cursor: cached(live.cursor),
    tools: cached(live.tools),
  };
  const deps: DryTurnDeps = {
    cached: vi.fn(() => state),
    agentsIntegration: vi.fn((depth: TurnDepth) => ({
      ...tool("agents"),
      env: { BOT: "atlas", OMB_TURN_DEPTH: String(depth) },
    })),
  };
  return { live, state, deps };
}

describe("turn shape", () => {
  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])("dry shape matches the live descriptor for a plain message (terminal %s, connected apps %s, agents on)", (terminal, apps) => {
    const { live, deps } = fixture();
    live.bot.shareTerminalWithChat = terminal;
    live.bot.composio = apps;
    const prepared = dryShape(deps, live);
    const actual = turnDescriptor(deps, live);
    expect(prepared).not.toBeNull();
    expect(prepared).toStrictEqual(actual);
    const expected: SendTurnInput = {
      threadId: live.threadId,
      text: live.tools.text,
      model: "grok-4.6",
      effort: "high",
      approval: "ask",
      resumeCursor: undefined,
      cwd: "D:\\fake\\project",
      integrations: {
        agents: { ...tool("agents"), env: { BOT: "atlas", OMB_TURN_DEPTH: "0" } },
      },
    };
    if (terminal) expected.integrations!.terminal = tool("terminal");
    if (apps) expected.integrations!.composio = tool("connected-apps");
    expect({ ...actual, text: live.tools.text }).toMatchObject(expected);
    expect(warmToolsKey(prepared!.integrations)).toBe(warmToolsKey(expected.integrations));
    const contract: PrepareTurn = prepared!;
    expect(contract.depth).toBe(0);
    expect(deps.agentsIntegration).toHaveBeenCalledWith(0);
  });

  it("every depth pair 0/1/2 yields distinct tool descriptors", () => {
    const { live, deps } = fixture();
    const keys = ([0, 1, 2] as const).map((depth) => warmToolsKey(turnDescriptor(deps, { ...live, depth })!.integrations));
    for (let a = 0; a < keys.length; a++) {
      for (let b = a + 1; b < keys.length; b++) expect(keys[a]).not.toBe(keys[b]);
    }
    expect(deps.agentsIntegration).toHaveBeenCalledTimes(3);
  });

  it("uses the injected agents descriptor unchanged", () => {
    const { live, deps } = fixture();
    const injected = { ...tool("custom-agents"), env: { DEPTH: "policy-owned", CAN_ASK: "policy-owned" } };
    deps.agentsIntegration = vi.fn(() => injected);
    expect(turnDescriptor(deps, { ...live, depth: 2 })!.integrations.agents).toBe(injected);
    expect(deps.agentsIntegration).toHaveBeenCalledWith(2);
  });

  it("a wrong instance or old generation yields a different shape", () => {
    const { live, deps, state } = fixture();
    const initial = dryShape(deps, live);
    expect(initial).not.toBeNull();
    expect(turnDescriptor(deps, { ...live, instance: { ...live.instance, instanceId: "other-instance" } })).not.toStrictEqual(initial);
    for (const captured of [
      { ...live.captured, generation: 3 },
      { ...live.captured, incarnation: "replacement-instance" },
      { ...live.captured, identity: "other-fake-auth-hash" },
    ]) {
      state.captured = cached(captured);
      expect(dryShape(deps, live)).not.toStrictEqual(initial);
    }
    expect(dryShape(deps, { ...live, instance: { ...live.instance, instanceId: "other-instance" } })).toBeNull();
  });

  it.each(["cursor", "folder"] as const)("unknown %s returns null", (field) => {
    const { live, state, deps } = fixture();
    state[field] = undefined;
    expect(dryShape(deps, live)).toBeNull();
    expect(deps.agentsIntegration).not.toHaveBeenCalled();
  });

  it("an uncached private workspace returns null without creating one", () => {
    const { live, deps } = fixture();
    live.folder.privateWorkspace = undefined;
    expect(dryShape(deps, live)).toBeNull();
  });

  it.each(["room", "selection", "captured", "tools"] as const)("unknown cached %s returns null", (field) => {
    const { live, state, deps } = fixture();
    state[field] = undefined;
    expect(dryShape(deps, live)).toBeNull();
  });

  it("omitted correctness fields never compare equal to known absence", () => {
    const { live, state, deps } = fixture();
    expect(dryShape(deps, live)).not.toBeNull();
    for (const object of [live.folder, live.cursor, live.tools, live.tools.connectedApps]) {
      for (const key of Object.keys(object)) {
        const property = Object.getOwnPropertyDescriptor(object, key)!;
        Reflect.deleteProperty(object, key);
        if (key !== "text") expect(dryShape(deps, live), key).toBeNull();
        Object.defineProperty(object, key, property);
      }
    }
    Reflect.set(state, "cursor", {});
    expect(dryShape(deps, live)).toBeNull();
  });

  it("phone tools come only from message text", () => {
    const { live, deps } = fixture();
    expect(turnDescriptor(deps, live)!.integrations.phone).toBeUndefined();
    for (const text of ["Use the phone", "휴대폰을 확인해 줘"]) {
      live.tools.text = text;
      expect(turnDescriptor(deps, live)!.integrations.phone).toEqual(tool("phone"));
      expect(dryShape(deps, live)!.integrations.phone).toBeUndefined();
    }
    expect(phoneDescriptor({ text: "phone", supported: false, skills: [phoneSkill], connection: tool("phone") })).toBeNull();
    expect(phoneDescriptor({ text: "phone", supported: true, skills: [{ ...phoneSkill, manifest: { ...phoneSkill.manifest, defaultEnabled: false } }], connection: tool("phone") })).toBeNull();
  });

  it("the folder follows the bot when the message names none", () => {
    const { live, deps } = fixture();
    expect(dryShape(deps, live)!.cwd).toBe(live.folder.botCwd);
    live.folder.botCwd = undefined;
    expect(dryShape(deps, live)!.cwd).toBe(live.folder.privateWorkspace);
  });

  it("keeps legacy null cwd, including an unpinned task with any provider cursor", () => {
    const { live, deps } = fixture();
    live.folder.taskCwd = null;
    expect(dryShape(deps, live)!.cwd).toBeUndefined();
    live.folder.taskCwd = undefined;
    live.folder.resumeCursors = { "other-instance": "legacy-session" };
    expect(dryShape(deps, live)!.cwd).toBeUndefined();
  });

  it("uses a named folder after resolution, keeping explicit bot and task pins", () => {
    const { live, deps } = fixture();
    live.folder.botCwd = undefined;
    live.folder.resolvedProject = "D:\\fake\\named";
    expect(dryShape(deps, live)!.cwd).toBe("D:\\fake\\named");
    live.folder.botCwd = "D:\\fake\\bot-pin";
    expect(dryShape(deps, live)!.cwd).toBe("D:\\fake\\bot-pin");
    live.folder.taskCwd = "D:\\fake\\task-pin";
    expect(dryShape(deps, live)!.cwd).toBe("D:\\fake\\task-pin");
    expect(cwdDescriptor({ ...live.folder, privateWorkspace: undefined })).toBeUndefined();
    expect(cwdDescriptor({ ...live.folder, runOn: "cloud" })).toBeUndefined();
  });

  it("distinguishes fresh, loaded, recycle and rewind cursors", () => {
    const { live, deps } = fixture();
    const fresh = turnDescriptor(deps, live)!;
    expect(fresh.session).toEqual({ kind: "fresh" });
    expect(canServeTurn(fresh.session, fresh.resumeCursor)).toBe(true);
    live.cursor.cursor = "session-1";
    const loaded = dryShape(deps, live)!;
    expect(loaded.session).toEqual({ kind: "loaded", id: "session-1" });
    expect(canServeTurn(loaded.session, "session-1")).toBe(true);
    expect(canServeTurn(loaded.session, "session-2")).toBe(false);
    live.cursor.cursor = "session-2";
    expect(dryShape(deps, live)!.session).toEqual({ kind: "loaded", id: "session-2" });
    for (const reset of [{ recycle: true }, { rewound: true }, { resume: false }]) {
      const next = turnDescriptor(deps, { ...live, cursor: { ...live.cursor, ...reset } })!;
      expect(next.session).toEqual({ kind: "fresh" });
      expect(next.resumeCursor).toBeUndefined();
      expect(canServeTurn(loaded.session, next.resumeCursor)).toBe(false);
    }
  });

  it("keeps argv session kind and declines unsupported session cursors", () => {
    const { live, deps } = fixture();
    live.cursor.sessionKind = "argv";
    live.cursor.cursor = "conversation-1";
    expect(dryShape(deps, live)!.session).toEqual({ kind: "argv" });
    expect(dryShape(deps, live)!.resumeCursor).toBe("conversation-1");
    expect(resumeDescriptor({ ...live.cursor, sessionKind: "session", cursor: {} })).toBeNull();
  });

  it.each([undefined, null, ""])("an explicitly known empty cursor starts fresh (%s)", (cursor) => {
    const { live, deps } = fixture();
    live.cursor.cursor = cursor;
    expect(dryShape(deps, live)!.session).toEqual({ kind: "fresh" });
    expect(Object.hasOwn(dryShape(deps, live)!, "resumeCursor")).toBe(true);
  });

  it("preserves resolved live computer and browser descriptors but declines dry computer mounts", () => {
    const { live, deps } = fixture();
    live.tools.otherIntegrations = {
      computer: { kind: "box", boxId: "fake-box", token: "fake-box-token" },
      browser: tool("browser"),
    };
    expect(turnDescriptor(deps, live)!.integrations).toMatchObject(live.tools.otherIntegrations);
    expect(dryShape(deps, live)).toBeNull();
    live.tools.otherIntegrations = { localComputer: { ...tool("cua"), scope: "local-computer" } };
    expect(turnDescriptor(deps, live)!.integrations).toMatchObject(live.tools.otherIntegrations);
    expect(dryShape(deps, live)).toBeNull();
  });

  it.each([
    ["vm", "box"],
    ["local", "box"],
    ["cloud", "vps"],
    ["cloud", "box"],
    [undefined, "box"],
    [undefined, "vps"],
  ] as const)("every computer kind returns null (%s, %s)", (computer, cloudBackend) => {
    const { live, deps } = fixture();
    const bot = { ...live.bot, computer, cloudBackend };
    expect(dryShape(deps, { ...live, bot })).toBeNull();
    expect(deps.cached).not.toHaveBeenCalled();
  });

  it.each(["claudeAgent", "codex", "boxAgent"])("Claude, Codex and the computer engine return null (%s)", (driverKind) => {
    const { live, deps } = fixture();
    expect(dryShape(deps, { ...live, instance: { ...live.instance, driverKind } })).toBeNull();
    expect(deps.cached).not.toHaveBeenCalled();
  });

  it("rooms and unresolved cached state return null", () => {
    const { live, deps, state } = fixture();
    state.room = cached(true);
    expect(dryShape(deps, live)).toBeNull();
    deps.cached = vi.fn(() => null);
    expect(dryShape(deps, live)).toBeNull();
  });

  it("uses resolved selection and drops per-bot effort for a cloud run", () => {
    const { live } = fixture();
    live.selection.model = "grok-4.7";
    live.selection.effort = "xhigh";
    expect(modelDescriptor(live)).toEqual({ model: "grok-4.7", effort: "xhigh" });
    expect(modelDescriptor({ ...live, runOn: "cloud" })).toEqual({ model: "grok-4.6", effort: undefined });
    expect(approvalDescriptor({ autoApprove: true })).toBe("auto");
    expect(approvalDescriptor({})).toBe("ask");
  });

  it("validates model-specific effort and declines invalid cached selection", () => {
    const { live, deps } = fixture();
    live.selection.model = "grok-4.5";
    live.selection.effort = "xhigh";
    expect(() => modelDescriptor(live)).toThrow("not offered");
    expect(dryShape(deps, live)).toBeNull();
  });

  it("gates connected apps on the bot, config and driver, and keeps dweb", () => {
    const { live, deps } = fixture();
    for (const change of [{ configured: false }, { supported: false }, { bot: { composio: false } }, { connection: null }]) {
      expect(connectedAppsDescriptor({ bot: live.bot, configured: true, supported: true, connection: tool("apps"), ...change })).toBeNull();
    }
    live.tools.terminal = null;
    live.tools.dwebUrl = "  http://127.0.0.1:9020  ";
    live.instance.adapter.capabilities.agentsMcp = false;
    expect(dryShape(deps, live)!.integrations).toEqual({ composio: tool("connected-apps"), dweb: { url: "http://127.0.0.1:9020" } });
    expect(deps.agentsIntegration).not.toHaveBeenCalled();
  });

  it("captures explicit known absence and never mutates the cached inputs", () => {
    const { live, deps } = fixture();
    live.selection.effort = undefined;
    const before = structuredClone(live);
    const descriptor = dryShape(deps, live)!;
    expect(descriptor).not.toBeNull();
    for (const key of ["effort", "cwd", "resumeCursor", "approval", "integrations", "captured", "depth"]) {
      expect(Object.hasOwn(descriptor, key)).toBe(true);
    }
    expect(live).toStrictEqual(before);
    expect(descriptor.captured).not.toBe(live.captured);
  });

  it("dry never calls a side-effect dep", () => {
    const { live, deps } = fixture();
    const effects = Object.fromEntries([
      "ensureWorkspace", "resolveProjectFolder", "rememberProjectCwd", "forgetProjectCwd", "pinTaskCwd",
      "containerComputerStatus", "readCuaConnection", "inspectVpsForAuto", "vpsComputerAction", "findBox", "provisionBox", "readyBox",
    ].map((name) => [name, vi.fn(() => { throw new Error(`unexpected ${name}`); })]));
    const withEffects = { ...deps, ...effects };
    expect(dryShape(withEffects, live)).not.toBeNull();
    for (const computer of ["vm", "local", "cloud", undefined] as const) {
      expect(dryShape(withEffects, { ...live, bot: { ...live.bot, computer } })).toBeNull();
    }
    for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
  });
});
