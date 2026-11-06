import { stat } from "node:fs/promises";

import { resolveAutomaticSelection, type AutomaticCandidate, type AutomaticCapability } from "./automatic-selection.ts";
import { applicableCompaction, knownCatalogContextWindow, supersededCompactionIds } from "./context-compaction.ts";
import type { ModelSelection, ProviderInstance } from "./contracts.ts";
import { shouldMountLocalComputer } from "./local-routing.ts";
import { resolveProjectFolder, userProjectTexts } from "./project-folder.ts";
import type { BotRecord, Store } from "./store.ts";
import { countLastTurnToolRounds, countSessionToolRounds, engineIsFresh, nativeSessionTokenBudget, resumeSessionUnseeded, sessionPromptFor, shouldRecycleProviderSession } from "./turn-context.ts";
import { dryShape, type ToolDescriptor, type TurnDepth, type TurnDescriptor } from "./turn-shape.ts";
import { supportsWorkspaceFiles, workspaceDir } from "./workspace.ts";

export interface PrewarmDeps {
  store: Pick<Store, "taskByThread" | "activePath" | "messagesFor">;
  platform: NodeJS.Platform;
  incarnation(instanceId: string): string | undefined;
  resolve(bot: Pick<BotRecord, "modelSelection">, required?: readonly AutomaticCapability[]): ModelSelection;
  requirements(bot: BotRecord): AutomaticCapability[];
  candidate(instanceId: string): AutomaticCandidate | undefined;
  accountOf(instanceId: string): string | undefined;
  agents(botId: string, threadId: string, depth: TurnDepth): ToolDescriptor;
  terminal(botId: string): ToolDescriptor | null;
  composioConfigured(): boolean;
  composio(botId: string, threadId: string): Promise<ToolDescriptor | null>;
  boxConfigured(): boolean;
}

export async function prewarmTurn(deps: PrewarmDeps, bot: BotRecord, instance: ProviderInstance): Promise<TurnDescriptor | null> {
  try {
    const threadId = bot.threadId;
    const instanceId = instance.instanceId;
    const kind = instance.driverKind;
    const caps = instance.adapter.capabilities;
    if (!["grokAgent", "museAgent"].includes(kind)) return null;
    const captured = instance.cachedCapture?.() ?? null;
    if (!captured || captured.incarnation !== deps.incarnation(instanceId)) return null;
    const task = deps.store.taskByThread(bot.id, threadId);
    if (!task) return null;
    const select = () => {
      const required = deps.requirements(bot);
      if (bot.modelSelection.mode !== "automatic") return deps.resolve(bot, required);
      const continuityId = task.lastInstanceId && (deps.accountOf(task.lastInstanceId) ?? task.lastInstanceId);
      const ids = [...new Set([continuityId, bot.modelSelection.instanceId].filter(Boolean))];
      const selection = resolveAutomaticSelection({
        candidates: ids.flatMap((id) => { const candidate = deps.candidate(id!); return candidate ? [candidate] : []; }),
        current: bot.modelSelection,
        continuity: { instanceId: continuityId || undefined, model: task.lastModel },
        required,
      });
      return selection ? deps.resolve({ modelSelection: selection }) : null;
    };
    const selection = select();
    if (!selection || selection.instanceId !== instanceId) return null;
    const effectiveBot = bot.computer === undefined && bot.cloudBackend !== "vps" && !deps.boxConfigured()
      && !shouldMountLocalComputer({ requested: undefined, hostPlatform: deps.platform, providerSupportsLocal: caps.localComputerMcp === true })
      ? { ...bot, computer: "off" as const } : bot;
    if (effectiveBot.computer !== "off") return null;
    const activeMessages = deps.store.activePath(threadId);
    const compaction = applicableCompaction(activeMessages);
    if (compaction && "unsupported" in compaction) return null;
    const latestCompactionId = compaction?.messageId ?? null;
    const supersededIds = supersededCompactionIds(activeMessages, latestCompactionId);
    const { model } = selection;
    const rewound = Boolean(bot.rewound);
    const hasPriorUserTurn = activeMessages.some((message) => message.role === "user" && message.kind === "text" && Boolean(message.text?.trim()));
    const fresh = !rewound && engineIsFresh({
      instanceId, model, lastInstanceId: task.lastInstanceId, lastModel: task.lastModel,
      sessionModelSwitch: caps.sessionModelSwitch, resumeCursors: task.resumeCursors, resumeCursor: caps.resumeCursor,
      transcript: [], hasPriorUserTurn,
    });
    const unseeded = (expanded: boolean) => !rewound && !fresh && resumeSessionUnseeded({
      instanceId, cursor: task.resumeCursors[instanceId], seed: task.resumeSeed, latestCompactionId, expanded, supersededIds,
    });
    if (unseeded(false) !== unseeded(true)) return null;
    const catalogWindow = knownCatalogContextWindow(instance.models, model);
    const sessionPrompt = sessionPromptFor({ report: task.nativePrompt, cursor: task.resumeCursors[instanceId], model, catalogWindow });
    const knownWindow = caps.turnInputIsPromptSize ? catalogWindow : null;
    const recycle = (recovering: boolean) => shouldRecycleProviderSession({
      compacted: unseeded(false), rewound, recovering,
      lastTurnToolRounds: countLastTurnToolRounds(activeMessages, new Set(), task.providerSessionBoundId),
      sessionToolRounds: countSessionToolRounds(activeMessages, new Set(), task.providerSessionBoundId),
      lastTurnInputTokens: task.usage?.lastInput,
      nativeTokenBudget: knownWindow ? nativeSessionTokenBudget(knownWindow) : 0, sessionPrompt,
    });
    const recycleWanted = recycle(false);
    if (recycleWanted !== recycle(true)) return null;
    const recycleDeferred = recycleWanted && !fresh && instance.adapter.hasBackgroundWork?.(threadId) === true;
    let resolvedProject: string | undefined;
    if (task.cwd === undefined && bot.cwd === undefined && !Object.keys(task.resumeCursors).length) {
      if (userProjectTexts(deps.store.messagesFor(threadId), undefined, { since: bot.projectFolderClearedAt }).length) return null;
      resolvedProject = resolveProjectFolder({ remembered: bot.lastProjectCwd, userTexts: [] }).cwd ?? undefined;
    }
    const snapshot = () => JSON.stringify([
      bot, deps.store.taskByThread(bot.id, threadId), deps.store.activePath(threadId), deps.store.messagesFor(threadId),
      select(), instance.cachedCapture?.(), deps.incarnation(instanceId), instance.models, caps,
      deps.composioConfigured(), deps.boxConfigured(), process.env.DWEB_URL, instance.adapter.hasBackgroundWork?.(threadId),
      deps.terminal(bot.id), deps.agents(bot.id, threadId, 0),
    ]);
    const before = snapshot();
    const current = () => bot.threadId === threadId && deps.store.taskByThread(bot.id, threadId) === task && snapshot() === before;
    const configured = deps.composioConfigured();
    const connection = bot.composio !== false && configured && caps.composioMcp === true
      ? await deps.composio(bot.id, threadId) : null;
    if (!current()) return null;
    const turn = dryShape({
      agentsIntegration: (depth) => deps.agents(bot.id, threadId, depth),
      cached: () => ({
        room: { value: false }, selection: { value: selection }, captured: { value: captured },
        folder: { value: {
          privateWorkspace: supportsWorkspaceFiles(kind) ? workspaceDir(bot.id) : undefined,
          taskCwd: task.cwd, botCwd: bot.cwd, resolvedProject, resumeCursors: task.resumeCursors,
        } },
        cursor: { value: { cursor: task.resumeCursors[instanceId], resume: !fresh, rewound, recycle: recycleWanted && !recycleDeferred, sessionKind: "session" } },
        tools: { value: {
          skills: [], terminal: deps.terminal(bot.id), phone: null, connectedApps: { configured, connection },
          dwebUrl: process.env.DWEB_URL ?? null, otherIntegrations: {},
        } },
      }),
    }, { bot: effectiveBot, threadId, instance });
    if (!turn) return null;
    if (turn.cwd && !(await stat(turn.cwd)).isDirectory()) return null;
    return current() ? turn : null;
  } catch {
    return null;
  }
}
