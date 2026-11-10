import type { ModelSelection, PrepareTurn, ProviderAdapter, ProviderInstance, SendTurnInput } from "./contracts.ts";
import type { Captured } from "./drivers/warm-pool.ts";
import type { WarmSession } from "./drivers/acp/warm-eligibility.ts";
import { isEffortOffered } from "../shared/model-effort.ts";
import { selectBundledSkills, type BundledSkill } from "./skill-library.ts";
import type { BotRecord } from "./store.ts";

export type TurnDepth = PrepareTurn["depth"];
export type TurnIntegrations = NonNullable<SendTurnInput["integrations"]>;
export type ToolDescriptor = NonNullable<TurnIntegrations["agents"]>;
export type TurnBot = Pick<BotRecord, "id" | "computer" | "autoApprove" | "shareTerminalWithChat" | "composio">;
export type TurnInstance = Pick<ProviderInstance, "instanceId" | "driverKind" | "models"> & {
  adapter: Pick<ProviderAdapter, "capabilities">;
};

export interface ModelDescriptorInput {
  selection: ModelSelection;
  instance: TurnInstance;
  runOn?: "cloud";
}

export function modelDescriptor({ selection, instance, runOn }: ModelDescriptorInput) {
  const model = runOn === "cloud" ? instance.models.default : selection.model;
  const effort = runOn === "cloud" ? undefined : selection.effort;
  if (effort && !isEffortOffered(instance.driverKind, model, effort, instance.adapter.capabilities.effortLevels ?? [])) {
    throw Object.assign(new Error(`effort "${effort}" is not offered by this bot's engine - choose another level in settings`), { status: 409 });
  }
  return { model, effort };
}

export function approvalDescriptor(bot: Pick<TurnBot, "autoApprove">): NonNullable<SendTurnInput["approval"]> {
  return bot.autoApprove ? "auto" : "ask";
}

export function terminalDescriptor(bot: Pick<TurnBot, "shareTerminalWithChat">, connection: ToolDescriptor | null) {
  return bot.shareTerminalWithChat !== false ? connection : null;
}

export interface PhoneDescriptorInput {
  text: string;
  supported: boolean;
  skills: readonly BundledSkill[];
  connection: ToolDescriptor | null;
}

export function phoneDescriptor({ text, supported, skills, connection }: PhoneDescriptorInput) {
  const selected = selectBundledSkills(text, supported ? ["phoneMcp"] : [], skills);
  return selected.some((skill) => skill.manifest.requiredCapabilities.includes("phoneMcp")) ? connection : null;
}

export interface ConnectedAppsDescriptorInput {
  bot: Pick<TurnBot, "composio">;
  configured: boolean;
  supported: boolean;
  connection: ToolDescriptor | null;
}

export function connectedAppsDescriptor({ bot, configured, supported, connection }: ConnectedAppsDescriptorInput) {
  return bot.composio !== false && configured && supported ? connection : null;
}

export interface CwdDescriptorInput {
  privateWorkspace: string | undefined;
  taskCwd: string | null | undefined;
  botCwd: string | undefined;
  resolvedProject: string | undefined;
  resumeCursors: Readonly<BotRecord["resumeCursors"]>;
  runOn?: "cloud";
}

export function cwdDescriptor(input: CwdDescriptorInput): string | undefined {
  if (!input.privateWorkspace || input.runOn === "cloud") return undefined;
  if (input.taskCwd !== undefined) return input.taskCwd ?? undefined;
  if (Object.keys(input.resumeCursors).length) return undefined;
  return input.botCwd ?? input.resolvedProject ?? input.privateWorkspace;
}

export interface ResumeDescriptorInput {
  cursor: unknown;
  resume: boolean;
  rewound: boolean;
  recycle: boolean;
  sessionKind: "session" | "argv";
}

export interface ResumeDescriptor {
  resumeCursor: unknown;
  session: WarmSession;
}

export function resumeDescriptor(input: ResumeDescriptorInput): ResumeDescriptor | null {
  const resumeCursor = input.resume && !input.rewound && !input.recycle ? input.cursor : undefined;
  if (input.sessionKind === "argv") return { resumeCursor, session: { kind: "argv" } };
  if (resumeCursor === undefined || resumeCursor === null || resumeCursor === "") {
    return { resumeCursor, session: { kind: "fresh" } };
  }
  return typeof resumeCursor === "string" ? { resumeCursor, session: { kind: "loaded", id: resumeCursor } } : null;
}

export interface IntegrationDescriptorInput {
  bot: TurnBot;
  capabilities: ProviderAdapter["capabilities"];
  depth: TurnDepth;
  text: string;
  skills: readonly BundledSkill[];
  terminal: ToolDescriptor | null;
  phone: ToolDescriptor | null;
  connectedApps: { configured: boolean; connection: ToolDescriptor | null };
  dwebUrl: string | null;
  otherIntegrations: Pick<TurnIntegrations, "computer" | "localComputer" | "browser">;
}

export interface AgentsDescriptorDeps {
  agentsIntegration(depth: TurnDepth): ToolDescriptor;
}

export function integrationDescriptors(deps: AgentsDescriptorDeps, input: IntegrationDescriptorInput): TurnIntegrations {
  const integrations: TurnIntegrations = { ...input.otherIntegrations };
  const terminal = terminalDescriptor(input.bot, input.terminal);
  if (terminal) integrations.terminal = terminal;
  const phone = phoneDescriptor({
    text: input.text,
    supported: input.capabilities.phoneMcp === true,
    skills: input.skills,
    connection: input.phone,
  });
  if (phone) integrations.phone = phone;
  const composio = connectedAppsDescriptor({
    bot: input.bot,
    supported: input.capabilities.composioMcp === true,
    ...input.connectedApps,
  });
  if (composio) integrations.composio = composio;
  const url = input.dwebUrl?.trim();
  if (url) integrations.dweb = { url };
  if (input.capabilities.agentsMcp === true) integrations.agents = deps.agentsIntegration(input.depth);
  return integrations;
}

export interface TurnDescriptor extends PrepareTurn {
  instanceId: string;
  model: string;
  effort: SendTurnInput["effort"];
  approval: NonNullable<SendTurnInput["approval"]>;
  cwd: string | undefined;
  resumeCursor: unknown;
  integrations: TurnIntegrations;
  session: WarmSession;
}

export interface TurnDescriptorInput extends ModelDescriptorInput {
  bot: TurnBot;
  threadId: string;
  depth: TurnDepth;
  captured: Captured;
  folder: CwdDescriptorInput;
  cursor: ResumeDescriptorInput;
  tools: Omit<IntegrationDescriptorInput, "bot" | "capabilities" | "depth">;
}

export function turnDescriptor(deps: AgentsDescriptorDeps, input: TurnDescriptorInput): TurnDescriptor | null {
  const cursor = resumeDescriptor(input.cursor);
  if (!cursor) return null;
  return {
    threadId: input.threadId,
    instanceId: input.instance.instanceId,
    ...modelDescriptor(input),
    approval: approvalDescriptor(input.bot),
    cwd: cwdDescriptor({ ...input.folder, runOn: input.runOn ?? input.folder.runOn }),
    ...cursor,
    depth: input.depth,
    captured: { ...input.captured },
    integrations: integrationDescriptors(deps, {
      ...input.tools,
      bot: input.bot,
      capabilities: input.instance.adapter.capabilities,
      depth: input.depth,
    }),
  };
}

// A missing cached snapshot must never stand in for empty turn fields;
// wrap absence with the outer `undefined`, never with `{ value: null | undefined }`.
export type Cached<T> = { value: T } | undefined;

export interface DryTurnState {
  room: Cached<boolean>;
  selection: Cached<ModelSelection>;
  captured: Cached<Captured>;
  folder: Cached<CwdDescriptorInput>;
  cursor: Cached<ResumeDescriptorInput>;
  tools: Cached<Omit<TurnDescriptorInput["tools"], "text">>;
}

export interface DryTurnInput {
  bot: TurnBot;
  threadId: string;
  instance: TurnInstance;
}

export interface DryTurnDeps extends AgentsDescriptorDeps {
  cached(input: DryTurnInput): DryTurnState | null;
}

function known<T>(cached: Cached<T>): cached is { value: T } {
  return cached !== undefined && cached !== null && Object.hasOwn(cached, "value") && cached.value !== undefined && cached.value !== null;
}

type CachedTurnFields = CwdDescriptorInput | ResumeDescriptorInput | Omit<TurnDescriptorInput["tools"], "text"> | IntegrationDescriptorInput["connectedApps"];

function hasFields(value: CachedTurnFields, keys: readonly string[]): boolean {
  return value !== undefined && value !== null && keys.every((key) => Object.hasOwn(value, key));
}

export function dryShape(deps: DryTurnDeps, input: DryTurnInput): TurnDescriptor | null {
  if (input.bot.computer !== "off" || ["claudeAgent", "codex", "boxAgent"].includes(input.instance.driverKind)) return null;
  const state = deps.cached(input);
  if (!state || !known(state.room) || state.room.value !== false || !known(state.selection) || !known(state.captured)
    || !known(state.folder) || !known(state.cursor) || !known(state.tools)) return null;
  const selection = state.selection.value;
  const captured = state.captured.value;
  const folder = state.folder.value;
  const cursor = state.cursor.value;
  const tools = state.tools.value;
  if (selection.instanceId !== input.instance.instanceId || !selection.model || !folder.privateWorkspace || folder.runOn === "cloud"
    || !Number.isFinite(captured.generation) || !captured.incarnation || !captured.identity
    || !hasFields(folder, ["privateWorkspace", "taskCwd", "botCwd", "resolvedProject", "resumeCursors"])
    || !hasFields(cursor, ["cursor", "resume", "rewound", "recycle", "sessionKind"])
    || !hasFields(tools, ["skills", "terminal", "phone", "connectedApps", "dwebUrl", "otherIntegrations"])
    || !hasFields(tools.connectedApps, ["configured", "connection"])
    || !tools.otherIntegrations || tools.otherIntegrations.computer || tools.otherIntegrations.localComputer) return null;
  // The live boundary validates effort after resolving selection; dry mode only declines preparation.
  try {
    return turnDescriptor(deps, {
      bot: input.bot,
      threadId: input.threadId,
      instance: input.instance,
      selection,
      captured,
      folder,
      cursor,
      tools: { ...tools, text: "" },
      depth: 0,
    });
  } catch {
    return null;
  }
}
