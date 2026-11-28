import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { readTaskResumePacket } from "./task-state.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { PRE_COMPACT_TOOL_ROUND_LIMIT } from "./turn-context.ts";
import { spawnHarness as spawn, harnessFetch as fetch } from "./testing/harness-auth.ts";
import { createFixtureHome, removeTestData } from "./testing/test-home.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CODEX_CLI = join(SERVER_DIR, "testing", "fake-codex-app-server.ts");
const FAKE_CLAUDE_CLI = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;

type CodexCall = {
  method: string;
  params: {
    threadId?: string;
    developerInstructions?: string;
    input?: Array<{ text: string }>;
    items?: Array<{ type: string; role: string; content: Array<{ text: string }> }>;
  };
};

function codexTurn(calls: CodexCall[], text: string) {
  const index = calls.findLastIndex((call) => call.method === "turn/start" && call.params.input?.[0]?.text.includes(text));
  if (index < 0) return null;
  const { params } = calls[index]!;
  const previous = calls.slice(0, index).findLast((call) => (call.method === "turn/start" || call.method === "thread/inject_items") &&
    call.params.threadId === params.threadId);
  const item = previous?.method === "thread/inject_items" ? previous.params.items?.[0] : undefined;
  return {
    prompt: params.input![0]!.text,
    history: item?.type === "message" && item.role === "user" ? item.content[0]?.text : undefined,
  };
}

const BOT_ID = "compaction-bot";
const THREAD_ID = "compaction-thread";
const CODEX_RESTORED = [
  { id: "restored-resume", cursor: "saved-resume", hasSessionSystem: true },
  { id: "restored-reset", cursor: "saved-reset", hasSessionSystem: false },
];
const COVERED_CONTACT = "covered-owner@example.test";
const LATER_CONTACT = "launch-owner@example.test";
const RECENT_MILESTONE = "violet telescope";
const CODEX_SWITCH = [
  { id: "restored-switch", summary: "The launch is approved for review." },
  { id: "restored-switch-full", summary: "The launch is approved for review. ".repeat(1_000).slice(0, 31_990) },
];
const switchRoom = (id: string) => `${id}-room`;
const CLAUDE_BOT_ID = "compaction-claude-bot";
const CLAUDE_THREAD_ID = "compaction-claude-thread";
const CLAUDE_RESUME = {
  botId: "compaction-claude-resume-bot",
  threadId: "compaction-claude-resume-thread",
  fatSession: "fat-session-abc",
};
const CLAUDE_FAT = {
  botId: "compaction-claude-fat-bot",
  threadId: "compaction-claude-fat-thread",
  fatSession: "fat-soak-session",
};
// made a plan and saved 11 shots outside its task folder, then 50 more tool rounds
const MARKETING = {
  botId: "compaction-marketing-bot",
  threadId: "compaction-marketing-thread",
  fatSession: "marketing-fat-session",
};
const ENGINE_SWITCH = { botId: "engine-switch-bot", threadId: "engine-switch-thread" };
const ENGINE_SWITCH_BRANCH = { botId: "engine-switch-branch-bot", threadId: "engine-switch-branch-thread" };
const CLAUDE_FAT_STOP = {
  botId: "compaction-claude-fat-stop-bot",
  threadId: "compaction-claude-fat-stop-thread",
  probeThreadId: "compaction-claude-fat-stop-probe",
  fatSession: "fat-soak-stop-session",
};
const CLAUDE_SLIM = {
  botId: "compaction-claude-slim-bot",
  threadId: "compaction-claude-slim-thread",
  probeThreadId: "compaction-claude-slim-probe",
  session: "slim-session",
};
// A cursor saved before 1.0.144: no record of the system text it started with.
const CLAUDE_UPDATE_DAY = {
  botId: "compaction-claude-update-day-bot",
  threadId: "compaction-claude-update-day-thread",
  session: "update-day-session",
};

function claudeResumeBot(input: {
  id: string;
  threadId: string;
  name: string;
  color: string;
  session: string;
  cwd?: string;
  previousSelection?: { instanceId: string; model: string };
  /** a spare task whose fresh turn shows the system text the server sends this bot */
  probeThreadId?: string;
}) {
  return {
    id: input.id,
    threadId: input.threadId,
    name: input.name,
    title: "Release owner",
    description: "Keep the release moving.",
    notifications: true,
    color: input.color,
    unread: false,
    modelSelection: { instanceId: "claude", model: "claude-fake" },
    resumeCursors: { claude: input.session },
    createdAt: 1,
    tasks: [{
      threadId: input.threadId,
      title: "Release",
      cwd: input.cwd,
      createdAt: 1,
      resumeCursors: { claude: input.session },
      // a prior turn certified this session with no summary
      resumeSeed: { instanceId: "claude", cursor: input.session, compactionId: null },
      lastInstanceId: input.previousSelection?.instanceId ?? "claude",
      lastModel: input.previousSelection?.model ?? "claude-fake",
    }, ...(input.probeThreadId
      ? [{ threadId: input.probeThreadId, title: "Probe", createdAt: 2, resumeCursors: {} }]
      : [])],
  };
}
const ROOM_FIRST = {
  botId: "room-first-bot",
  botThreadId: "room-first-direct-thread",
  groupId: "room-first-group",
  roomThreadId: "room-first-room-thread",
};
const DIRECT_FIRST = {
  botId: "direct-first-bot",
  botThreadId: "direct-first-direct-thread",
  groupId: "direct-first-group",
  roomThreadId: "direct-first-room-thread",
};
const ROOM_TASK = {
  botId: "room-task-bot",
  botThreadId: "room-task-direct-thread",
  groupId: "room-task-group",
  roomThreadId: "room-task-room-thread",
};
const ROOM_TASK_NEXT = { botId: "room-task-next-bot", botThreadId: "room-task-next-thread" };
const ROOM_TASK_SURVIVOR = { botId: "room-task-survivor-bot", botThreadId: "room-task-survivor-thread" };
const EDIT_CLAIM = { botId: "edit-claim-bot", botThreadId: "edit-claim-thread" };
const NEW_TASK_CLAIM = { botId: "new-task-claim-bot", botThreadId: "new-task-claim-thread" };
const CLEAR_RACE = { botId: "clear-race-bot", botThreadId: "clear-race-thread" };
const GOAL_STRIP = { botId: "goal-strip-bot", botThreadId: "goal-strip-thread" };
const GOAL_LEGACY = { botId: "goal-legacy-bot", botThreadId: "goal-legacy-thread" };
const GOAL_OWNED = { botId: "goal-owned-bot", botThreadId: "goal-owned-thread" };
const PLAN_SEED = { botId: "plan-seed-bot", botThreadId: "plan-seed-thread" };
const PLAN_ONLY = { botId: "plan-only-bot", botThreadId: "plan-only-thread" };
const GOAL_ONLY = { botId: "goal-only-bot", botThreadId: "goal-only-thread" };
const PLAN_CLEARED = { botId: "plan-cleared-bot", botThreadId: "plan-cleared-thread" };
const ASKS_CODEX = { botId: "asks-codex-bot", botThreadId: "asks-codex-thread", name: "Asks codex", selection: { instanceId: "codex", model: "gpt-fake-default" } };
const ASKS_CLAUDE = { botId: "asks-claude-bot", botThreadId: "asks-claude-thread", name: "Asks claude", selection: { instanceId: "claude", model: "claude-fake" } };
const ROOM_ASKS = { botId: "room-asks-bot", botThreadId: "room-asks-direct-thread", groupId: "room-asks-group", roomThreadId: "room-asks-room-thread", name: "Room asks", instanceId: "claude", days: 2 };
const ROOM_LAUNCH = { botId: "room-launch-bot", botThreadId: "room-launch-direct-thread", groupId: "room-launch-group", roomThreadId: "room-launch-room-thread", name: "Room launch", instanceId: "claude-missing", days: 4 };
const SECRET_COLLISION = {
  botId: "secret-collision-bot",
  botThreadId: "secret-collision-direct-thread",
  groupId: "secret-collision-group",
  roomThreadId: "secret-collision-room-thread",
};

interface TaskStateFields {
  goal?: string;
  plan?: Array<{ step: string; status: "pending" | "active" | "done" | "skipped" }>;
  asks?: Array<{ id?: string; ask?: string; status: string }>;
  artifacts?: Array<{ ref: string; label: string }>;
}

type ApiBody =
  | { text: string }
  | { title: string }
  | { threadId: string }
  | { memberIds: string[] }
  | { modelSelection: { mode: "pinned"; instanceId: string; model: string; effort: string } }
  | { cwd: string | null }
  | { messageId: string };

describe("context compaction e2e", () => {
  let child: ChildProcess;
  let home: string;
  let dumpPath: string;
  let claudeDumpPath: string;
  let claudePromptLogPath: string;
  let clearRaceProject: string;
  let stderr = "";

  const api = async (method: string, path: string, body?: ApiBody): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
  // what a restart reads: a send's record is staged until its dispatch ends
  const storedTaskPacket = (threadId: string): any =>
    readTaskResumePacket(threadId, { dir: join(home, ".orbit", "task-state") });
  const botById = async (botId: string) =>
    (await api("GET", "/api/bots")).body.bots.find((candidate: { id: string }) => candidate.id === botId);
  /** Drive update_task_state the way the agents-proxy does, with the token the turn handed it. */
  const botTaskState = (botId: string, threadId: string, fields: TaskStateFields, engineToken?: string) => {
    const token = engineToken ?? JSON.parse(readFileSync(claudeDumpPath, "utf8")).mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
    return fetch(`${BASE}/api/internal/task-state`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ fromBotId: botId, fromThreadId: threadId, ...fields }),
    });
  };

  // store.ts keys one file per resume cursor this way
  const sessionSystemPath = (cursor: string, instanceId = "claude") => join(
    home,
    ".orbit",
    "session-system",
    `${createHash("sha256").update(`${instanceId}\n${JSON.stringify(cursor)}`).digest("hex").slice(0, 32)}.txt`,
  );
  /** Records the bot's saved session as already holding the system text the
   * server sends it, read off a real fresh turn on the bot's probe task so
   * the thread under test is untouched. */
  const seedSessionSystem = async (bot: { botId: string; threadId: string; probeThreadId: string }, cursor: string) => {
    expect((await api("POST", `/api/bots/${bot.botId}/tasks/${bot.probeThreadId}`)).status).toBe(200);
    rmSync(claudeDumpPath, { force: true });
    expect((await api("POST", `/api/bots/${bot.botId}/messages`, { text: "hello" })).status).toBe(202);
    await waitFor(async () => (await botById(bot.botId))?.busy === false);
    const probe = z.object({ argv: z.array(z.string()), systemPrompt: z.string() })
      .parse(JSON.parse(readFileSync(claudeDumpPath, "utf8")));
    expect(probe.argv).not.toContain("--resume");
    expect((await api("POST", `/api/bots/${bot.botId}/tasks/${bot.threadId}`)).status).toBe(200);
    mkdirSync(dirname(sessionSystemPath(cursor)), { recursive: true });
    writeFileSync(sessionSystemPath(cursor), probe.systemPrompt);
    return probe.systemPrompt;
  };

  const waitFor = async (predicate: () => Promise<boolean>, timeout = 20_000) => {
    const deadline = Date.now() + timeout;
    while (!(await predicate())) {
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      if (Date.now() > deadline) throw new Error(`timed out waiting for server state. stderr:\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  const startServer = async () => {
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "Roaming"),
      LOCALAPPDATA: join(home, "Local"),
      OMB_DATA_DIR: join(home, ".orbit"),
      OMB_USER_DATA: join(home, "user-data"),
      CODEX_HOME: join(home, ".codex"),
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      NODE_OPTIONS: process.env.NODE_OPTIONS,
      OMB_PORT: String(PORT),
    };
    if (process.env.PATH) env.PATH = process.env.PATH;
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stderr!.on("data", (chunk) => (stderr += chunk));

    await waitFor(async () => {
      try {
        return (await fetch(`${BASE}/api/health`)).ok;
      } catch {
        return false;
      }
    });
    await waitFor(async () => {
      const instances = (await api("GET", "/api/instances")).body.instances;
      return ["codex", "claude"].every((instanceId) =>
        instances.find((instance: { instanceId: string }) => instance.instanceId === instanceId)?.snapshot.state === "available",
      );
    });
  };

  beforeAll(async () => {
    chmodSync(FAKE_CODEX_CLI, 0o755);
    chmodSync(FAKE_CLAUDE_CLI, 0o755);
    home = createFixtureHome("orbit-compaction-e2e-");
    dumpPath = join(home, "codex-dump.json");
    claudeDumpPath = join(home, "claude-dump.json");
    claudePromptLogPath = join(home, "claude-prompts.ndjson");
    clearRaceProject = join(home, "clear-race-project");
    mkdirSync(clearRaceProject);
    const dataDir = join(home, ".orbit");
    mkdirSync(join(dataDir, "task-state"), { recursive: true });
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({
      instances: {
        codex: {
          driver: "codex",
          environment: { FAKE_CODEX_DUMP: dumpPath },
          config: { cli: FAKE_CODEX_CLI },
        },
        claude: {
          driver: "claudeAgent",
          environment: {
            FAKE_CLAUDE_DUMP: claudeDumpPath,
            FAKE_CLAUDE_PROMPT_LOG: claudePromptLogPath,
            FAKE_CLAUDE_GENERATE_DELAY_MS: "1500",
          },
          config: { cli: FAKE_CLAUDE_CLI },
        },
        "claude-missing": { driver: "claudeAgent", config: { cli: join(home, "missing-claude") } },
      },
    }));
    writeFileSync(join(dataDir, "bots.json"), JSON.stringify([
      ...CODEX_SWITCH.map(({ id }) => ({
        id, threadId: id, name: "Restored handoff", title: "Release", color: "blue", createdAt: 1,
        modelSelection: { instanceId: "codex", model: "gpt-fake-default" },
        resumeCursors: {}, tasks: [{ threadId: id, title: "Release", createdAt: 1, resumeCursors: {} }],
      })),
      ...CODEX_RESTORED.map(({ id, cursor }) => ({
        id, threadId: id, name: "Restored", title: "Release", color: "blue", createdAt: 1,
        modelSelection: { instanceId: "codex", model: "gpt-fake-default" },
        resumeCursors: { codex: cursor },
        tasks: [{
          threadId: id, title: "Release", createdAt: 1, resumeCursors: { codex: cursor },
          resumeSeed: { instanceId: "codex", cursor, compactionId: "saved", nativeReplay: true },
          nativePrompt: { cursor, first: 20_000, last: 20_000, window: { model: "gpt-fake-default", tokens: 128_000 } },
          lastInstanceId: "codex", lastModel: "gpt-fake-default",
        }],
      })),
      {
        id: BOT_ID,
        threadId: THREAD_ID,
        name: "Continuity",
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "blue",
        unread: false,
        modelSelection: { instanceId: "codex", model: "gpt-fake-default" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: THREAD_ID, title: "Release", createdAt: 1, resumeCursors: {} }],
      },
      {
        id: CLAUDE_BOT_ID,
        threadId: CLAUDE_THREAD_ID,
        name: "Summary",
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "green",
        unread: false,
        modelSelection: { instanceId: "claude", model: "claude-fake" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: CLAUDE_THREAD_ID, title: "Release", createdAt: 1, resumeCursors: {} }],
      },
      claudeResumeBot({
        id: CLAUDE_RESUME.botId,
        threadId: CLAUDE_RESUME.threadId,
        name: "Resume recycle",
        color: "teal",
        session: CLAUDE_RESUME.fatSession,
      }),
      claudeResumeBot({
        id: CLAUDE_FAT.botId,
        threadId: CLAUDE_FAT.threadId,
        name: "Fat soak recycle",
        color: "orange",
        session: CLAUDE_FAT.fatSession,
      }),
      claudeResumeBot({
        id: MARKETING.botId,
        threadId: MARKETING.threadId,
        name: "Marketing",
        color: "pink",
        session: MARKETING.fatSession,
        cwd: join(home, "launch"),
      }),
      claudeResumeBot({
        id: ENGINE_SWITCH.botId,
        threadId: ENGINE_SWITCH.threadId,
        name: "Engine switch",
        color: "pink",
        session: "older-claude-session",
        previousSelection: { instanceId: "codex", model: "gpt-fake-default" },
      }),
      claudeResumeBot({
        id: ENGINE_SWITCH_BRANCH.botId,
        threadId: ENGINE_SWITCH_BRANCH.threadId,
        name: "Engine switch branch",
        color: "pink",
        session: "older-claude-branch-session",
        previousSelection: { instanceId: "codex", model: "gpt-fake-default" },
      }),
      claudeResumeBot({
        id: CLAUDE_FAT_STOP.botId,
        threadId: CLAUDE_FAT_STOP.threadId,
        name: "Fat soak stop",
        color: "red",
        session: CLAUDE_FAT_STOP.fatSession,
        probeThreadId: CLAUDE_FAT_STOP.probeThreadId,
      }),
      claudeResumeBot({
        id: CLAUDE_SLIM.botId,
        threadId: CLAUDE_SLIM.threadId,
        name: "Slim resume",
        color: "gray",
        session: CLAUDE_SLIM.session,
        probeThreadId: CLAUDE_SLIM.probeThreadId,
      }),
      claudeResumeBot({
        id: CLAUDE_UPDATE_DAY.botId,
        threadId: CLAUDE_UPDATE_DAY.threadId,
        name: "Update day",
        color: "blue",
        session: CLAUDE_UPDATE_DAY.session,
      }),
      {
        id: ROOM_FIRST.botId,
        threadId: ROOM_FIRST.botThreadId,
        name: "Room first",
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "purple",
        unread: false,
        modelSelection: { instanceId: "claude", model: "claude-fake" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: ROOM_FIRST.botThreadId, title: "Release", createdAt: 1, resumeCursors: {} }],
      },
      {
        id: DIRECT_FIRST.botId,
        threadId: DIRECT_FIRST.botThreadId,
        name: "Direct first",
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "orange",
        unread: false,
        modelSelection: { instanceId: "claude", model: "claude-fake" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: DIRECT_FIRST.botThreadId, title: "Release", createdAt: 1, resumeCursors: {} }],
      },
      {
        id: ROOM_TASK.botId,
        threadId: ROOM_TASK.botThreadId,
        name: "Room continuity",
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "blue",
        unread: false,
        modelSelection: { instanceId: "codex", model: "gpt-fake-default" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: ROOM_TASK.botThreadId, title: "Release", createdAt: 1, resumeCursors: {} }],
      },
      {
        id: ROOM_TASK_NEXT.botId,
        threadId: ROOM_TASK_NEXT.botThreadId,
        name: "Next owner",
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "green",
        unread: false,
        modelSelection: { instanceId: "codex", model: "gpt-fake-default" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: ROOM_TASK_NEXT.botThreadId, title: "Release", createdAt: 1, resumeCursors: {} }],
      },
      {
        id: ROOM_TASK_SURVIVOR.botId,
        threadId: ROOM_TASK_SURVIVOR.botThreadId,
        name: "Survivor",
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "orange",
        unread: false,
        modelSelection: { instanceId: "codex", model: "gpt-fake-default" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: ROOM_TASK_SURVIVOR.botThreadId, title: "Release", createdAt: 1, resumeCursors: {} }],
      },
      {
        id: EDIT_CLAIM.botId,
        threadId: EDIT_CLAIM.botThreadId,
        name: "Edit guard",
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "purple",
        unread: false,
        modelSelection: { instanceId: "claude", model: "claude-fake" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: EDIT_CLAIM.botThreadId, title: "Release", createdAt: 1, resumeCursors: {} }],
      },
      {
        id: NEW_TASK_CLAIM.botId,
        threadId: NEW_TASK_CLAIM.botThreadId,
        name: "Task guard",
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "blue",
        unread: false,
        modelSelection: { instanceId: "claude", model: "claude-fake" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: NEW_TASK_CLAIM.botThreadId, title: "Release", createdAt: 1, resumeCursors: {} }],
      },
      {
        id: GOAL_OWNED.botId,
        threadId: GOAL_OWNED.botThreadId,
        name: "Goal owned",
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "teal",
        unread: false,
        modelSelection: { instanceId: "claude", model: "claude-fake" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: GOAL_OWNED.botThreadId, title: "Release", createdAt: 1, resumeCursors: {} }],
      },
      {
        id: GOAL_ONLY.botId,
        threadId: GOAL_ONLY.botThreadId,
        name: "Goal only",
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "teal",
        unread: false,
        modelSelection: { instanceId: "claude", model: "claude-fake" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: GOAL_ONLY.botThreadId, title: "Release", createdAt: 1, resumeCursors: {} }],
      },
      {
        id: PLAN_CLEARED.botId,
        threadId: PLAN_CLEARED.botThreadId,
        name: "Plan cleared",
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "orange",
        unread: false,
        modelSelection: { instanceId: "claude", model: "claude-fake" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: PLAN_CLEARED.botThreadId, title: "Release", createdAt: 1, resumeCursors: {} }],
      },
      {
        id: PLAN_ONLY.botId,
        threadId: PLAN_ONLY.botThreadId,
        name: "Plan only",
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "green",
        unread: false,
        modelSelection: { instanceId: "claude", model: "claude-fake" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: PLAN_ONLY.botThreadId, title: "Release", createdAt: 1, resumeCursors: {} }],
      },
      {
        id: PLAN_SEED.botId,
        threadId: PLAN_SEED.botThreadId,
        name: "Plan seed",
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "purple",
        unread: false,
        modelSelection: { instanceId: "claude", model: "claude-fake" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: PLAN_SEED.botThreadId, title: "Release", createdAt: 1, resumeCursors: {} }],
      },
      {
        id: GOAL_STRIP.botId,
        threadId: GOAL_STRIP.botThreadId,
        name: "Goal strip",
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "green",
        unread: false,
        modelSelection: { instanceId: "claude", model: "claude-fake" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: GOAL_STRIP.botThreadId, title: "Release", createdAt: 1, resumeCursors: {} }],
      },
      {
        id: GOAL_LEGACY.botId,
        threadId: GOAL_LEGACY.botThreadId,
        name: "Goal legacy",
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "orange",
        unread: false,
        modelSelection: { instanceId: "claude", model: "claude-fake" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: GOAL_LEGACY.botThreadId, title: "Release", createdAt: 1, resumeCursors: {} }],
      },
      {
        id: CLEAR_RACE.botId,
        threadId: CLEAR_RACE.botThreadId,
        name: "Clear race",
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "teal",
        unread: false,
        modelSelection: { instanceId: "claude", model: "claude-fake" },
        resumeCursors: {},
        lastProjectCwd: clearRaceProject,
        createdAt: 1,
        tasks: [{ threadId: CLEAR_RACE.botThreadId, title: "Release", createdAt: 1, resumeCursors: {} }],
      },
      {
        id: SECRET_COLLISION.botId,
        threadId: SECRET_COLLISION.botThreadId,
        name: "Secret retry",
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "green",
        unread: false,
        modelSelection: { instanceId: "claude", model: "claude-fake" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: SECRET_COLLISION.botThreadId, title: "Release", createdAt: 1, resumeCursors: {} }],
      },
      ...[ROOM_ASKS, ROOM_LAUNCH].map((room) => ({
        id: room.botId,
        threadId: room.botThreadId,
        name: room.name,
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "green",
        unread: false,
        modelSelection: { instanceId: room.instanceId, model: "claude-fake" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: room.botThreadId, title: "Release", createdAt: 1, resumeCursors: {} }],
      })),
      ...[ASKS_CODEX, ASKS_CLAUDE].map((bot) => ({
        id: bot.botId,
        threadId: bot.botThreadId,
        name: bot.name,
        title: "Release owner",
        description: "Keep the release moving.",
        notifications: true,
        color: "blue",
        unread: false,
        modelSelection: bot.selection,
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: bot.botThreadId, title: "Release", createdAt: 1, resumeCursors: {} }],
      })),
    ]));
    writeFileSync(join(dataDir, "groups.json"), JSON.stringify([
      ...CODEX_SWITCH.map(({ id }) => ({
        id: switchRoom(id), threadId: `${switchRoom(id)}-thread`, name: "Handoff room", memberIds: [id],
        defaultResponder: { kind: "member", botId: id }, bulletin: "", unread: false, createdAt: 1,
        tasks: [{ threadId: `${switchRoom(id)}-thread`, title: "Release", createdAt: 1 }],
      })),
      {
        id: ROOM_FIRST.groupId,
        threadId: ROOM_FIRST.roomThreadId,
        name: "Room first race",
        memberIds: [ROOM_FIRST.botId],
        defaultResponder: { kind: "member", botId: ROOM_FIRST.botId },
        bulletin: "",
        unread: false,
        createdAt: 1,
        tasks: [{ threadId: ROOM_FIRST.roomThreadId, title: "Release", createdAt: 1 }],
      },
      {
        id: DIRECT_FIRST.groupId,
        threadId: DIRECT_FIRST.roomThreadId,
        name: "Direct first race",
        memberIds: [DIRECT_FIRST.botId],
        defaultResponder: { kind: "member", botId: DIRECT_FIRST.botId },
        bulletin: "",
        unread: false,
        createdAt: 1,
        tasks: [{ threadId: DIRECT_FIRST.roomThreadId, title: "Release", createdAt: 1 }],
      },
      {
        id: ROOM_TASK.groupId,
        threadId: ROOM_TASK.roomThreadId,
        name: "Room continuity",
        memberIds: [ROOM_TASK.botId, ROOM_TASK_NEXT.botId, ROOM_TASK_SURVIVOR.botId],
        defaultResponder: { kind: "member", botId: ROOM_TASK.botId },
        bulletin: "Preserve verified release evidence.",
        unread: false,
        createdAt: 1,
        tasks: [{ threadId: ROOM_TASK.roomThreadId, title: "Release", createdAt: 1 }],
      },
      {
        id: SECRET_COLLISION.groupId,
        threadId: SECRET_COLLISION.roomThreadId,
        name: "Secret retry",
        memberIds: [SECRET_COLLISION.botId],
        defaultResponder: { kind: "member", botId: SECRET_COLLISION.botId },
        bulletin: "",
        unread: false,
        createdAt: 1,
        tasks: [{ threadId: SECRET_COLLISION.roomThreadId, title: "Release", createdAt: 1 }],
      },
      ...[ROOM_ASKS, ROOM_LAUNCH].map((room) => ({
        id: room.groupId,
        threadId: room.roomThreadId,
        name: room.name,
        memberIds: [room.botId],
        defaultResponder: { kind: "member", botId: room.botId },
        bulletin: "",
        unread: false,
        createdAt: 1,
        tasks: [{ threadId: room.roomThreadId, title: "Release", createdAt: 1 }],
      })),
    ]));
    // 61 user turns, one past the compaction cap, so every thread below compacts on its next send.
    const messages = Array.from({ length: 121 }, (_, index) => ({
      id: `m${index}`,
      at: index + 1,
      parentId: index ? `m${index - 1}` : null,
      role: index % 2 === 0 ? "user" : "bot",
      kind: "text",
      text: `history ${index}`,
    }));
    for (const { id, summary } of CODEX_SWITCH) writeFileSync(join(dataDir, `messages-${id}.json`), JSON.stringify({
      activeLeafId: "milestone",
      messages: [
        { id: "covered", at: 1, parentId: null, role: "user", kind: "text", text: `Send the handoff to ${COVERED_CONTACT}.` },
        { id: "saved", at: 2, parentId: "covered", role: "bot", kind: "compaction", compaction: {
          v: 1, summary, coveredThroughId: "covered", firstKeptId: null,
          contextWindow: 128_000, estimatedTokensBefore: 30, sourceMessageCount: 1,
        } },
        { id: "later", at: 3, parentId: "saved", role: "user", kind: "text", text: `Please use ${LATER_CONTACT} for the release handoff.` },
        { id: "archive1", at: 4, parentId: "later", role: "user", kind: "text", text: "First archived log. " + "an example line. ".repeat(7_000) },
        { id: "archive2", at: 5, parentId: "archive1", role: "user", kind: "text", text: "Second archived log. " + "another example line. ".repeat(5_300) },
        { id: "milestone", at: 6, parentId: "archive2", role: "user", kind: "text", text: `The current milestone is ${RECENT_MILESTONE}.` },
      ],
    }));
    for (const { id, cursor, hasSessionSystem } of CODEX_RESTORED) {
      writeFileSync(join(dataDir, `messages-${id}.json`), JSON.stringify({
        activeLeafId: "milestone",
        messages: [
          { id: "covered", at: 1, parentId: null, role: "user", kind: "text", text: `Send the handoff to ${COVERED_CONTACT}.` },
          { id: "saved", at: 2, parentId: "covered", role: "bot", kind: "compaction", compaction: {
            v: 1, summary: "The launch is approved for review.", coveredThroughId: "covered", firstKeptId: null,
            contextWindow: 128_000, estimatedTokensBefore: 30, sourceMessageCount: 1,
          } },
          ...messages.map((message, index) => ({ ...message, at: index + 3, parentId: message.parentId ?? "saved" })),
          { id: "contact", at: 124, parentId: "m120", role: "bot", kind: "text", text: `The later contact is ${LATER_CONTACT}.` },
          { id: "milestone", at: 125, parentId: "contact", role: "user", kind: "text", text: `The current milestone is ${RECENT_MILESTONE}.` },
        ],
      }));
      if (hasSessionSystem) {
        const systemPath = sessionSystemPath(cursor, "codex");
        mkdirSync(dirname(systemPath), { recursive: true });
        writeFileSync(systemPath, "You are Restored, a personal bot in Wink.");
      }
    }
    for (const threadId of [
      THREAD_ID,
      CLAUDE_THREAD_ID,
      CLAUDE_RESUME.threadId,
      ROOM_FIRST.botThreadId,
      ROOM_FIRST.roomThreadId,
      DIRECT_FIRST.botThreadId,
      DIRECT_FIRST.roomThreadId,
      ROOM_TASK.roomThreadId,
      EDIT_CLAIM.botThreadId,
      NEW_TASK_CLAIM.botThreadId,
      CLEAR_RACE.botThreadId,
      SECRET_COLLISION.botThreadId,
      SECRET_COLLISION.roomThreadId,
      ASKS_CODEX.botThreadId,
      ASKS_CLAUDE.botThreadId,
    ]) {
      writeFileSync(join(dataDir, `messages-${threadId}.json`), JSON.stringify({
        activeLeafId: "m120",
        messages,
      }));
    }
    const fatMessages = [
      { id: "f0", at: 1, parentId: null, role: "user", kind: "text", text: "inspect the tree" },
      ...Array.from({ length: PRE_COMPACT_TOOL_ROUND_LIMIT }, (_, index) => ({
        id: `ft${index}`,
        at: index + 2,
        parentId: index === 0 ? "f0" : `ft${index - 1}`,
        role: "bot",
        kind: "activity",
        tool: { name: `Read: file-${index}.ts`, ok: true },
      })),
      {
        id: "fa",
        at: PRE_COMPACT_TOOL_ROUND_LIMIT + 2,
        parentId: `ft${PRE_COMPACT_TOOL_ROUND_LIMIT - 1}`,
        role: "bot",
        kind: "text",
        text: "tree inspected",
      },
    ];
    const slimMessages = [
      { id: "s0", at: 1, parentId: null, role: "user", kind: "text", text: "say hi" },
      { id: "st0", at: 2, parentId: "s0", role: "bot", kind: "activity", tool: { name: "Read: readme.md", ok: true } },
      { id: "st1", at: 3, parentId: "st0", role: "bot", kind: "activity", tool: { name: "Write", ok: true, writes: [join(home, "launch", "real-shots", "cover.png")] } },
      { id: "sa", at: 4, parentId: "st1", role: "bot", kind: "text", text: "hello" },
    ];
    writeFileSync(join(dataDir, `messages-${CLAUDE_FAT.threadId}.json`), JSON.stringify({
      activeLeafId: "fa",
      messages: fatMessages,
    }));
    writeFileSync(join(dataDir, `messages-${CLAUDE_FAT_STOP.threadId}.json`), JSON.stringify({
      activeLeafId: "fa",
      messages: fatMessages,
    }));
    for (const threadId of [CLAUDE_SLIM.threadId, CLAUDE_UPDATE_DAY.threadId, ENGINE_SWITCH.threadId]) {
      writeFileSync(join(dataDir, `messages-${threadId}.json`), JSON.stringify({
        activeLeafId: "sa",
        messages: slimMessages,
      }));
    }
    writeFileSync(join(dataDir, `messages-${ENGINE_SWITCH_BRANCH.threadId}.json`), JSON.stringify({
      activeLeafId: "alternate",
      messages: [...slimMessages, { id: "alternate", at: 5, parentId: "s0", role: "bot", kind: "text", text: "other branch" }],
    }));
    const launch = join(home, "launch");
    const shots = Array.from({ length: 11 }, (_, index) => join(launch, "real-shots", `workers-${index + 1}.png`));
    const marketingMessages = [
      { id: "k0", at: 1, parentId: null, role: "user", kind: "text", text: "plan the launch posts and keep the worker shots" },
      { id: "kp", at: 2, parentId: "k0", role: "bot", kind: "activity", tool: { name: "Write", ok: true, writes: [join(launch, "paste", "03-thursday.md")] } },
      // copied with Bash, so only the task record knows them
      ...shots.map((_, index) => ({ id: `ks${index}`, at: index + 3, parentId: index ? `ks${index - 1}` : "kp", role: "bot", kind: "activity", tool: { name: "Bash", ok: true } })),
      ...Array.from({ length: 50 }, (_, index) => ({
        id: `kr${index}`,
        at: index + 20,
        parentId: index ? `kr${index - 1}` : "ks10",
        role: "bot",
        kind: "activity",
        tool: { name: `Read: src-${index}.ts`, ok: true },
      })),
      { id: "ka", at: 80, parentId: "kr49", role: "bot", kind: "text", text: "all set" },
    ];
    writeFileSync(join(dataDir, `messages-${MARKETING.threadId}.json`), JSON.stringify({ activeLeafId: "ka", messages: marketingMessages }));
    writeFileSync(join(dataDir, "task-state", `${MARKETING.threadId}.json`), JSON.stringify({
      v: 1,
      threadId: MARKETING.threadId,
      botId: MARKETING.botId,
      goal: "Run the Reddit launch",
      plan: [{ step: "Post Thursday", status: "active" }, { step: `Follow ${join(launch, "My Drive", "release.md")}`, status: "pending" }],
      completed: [],
      evidence: [],
      artifacts: [
        { ref: join(launch, "paste", "03-thursday.md"), label: "Reddit launch plan" },
        ...shots.map((ref, index) => ({ ref, label: `Worker shot ${index + 1}` })),
        ...[1, 2, 3].map((index) => ({ ref: join(launch, "drafts", `draft-${index}.md`), label: `Draft ${index}` })),
      ],
      blockers: [],
      nextAction: "Post Thursday",
      updatedAt: 1,
      updatedBy: "harness",
      flushReason: "progress",
      turnsAtWrite: 0,
    }));
    mkdirSync(launch, { recursive: true });
    writeFileSync(join(dataDir, "task-state", `${CLAUDE_FAT_STOP.threadId}.json`), JSON.stringify({
      v: 1,
      threadId: CLAUDE_FAT_STOP.threadId,
      botId: CLAUDE_FAT_STOP.botId,
      goal: "Inspect the tree",
      plan: [{ step: "Keep reading files", status: "active" }],
      completed: [],
      evidence: [],
      artifacts: [],
      blockers: [],
      nextAction: "Keep reading files",
      updatedAt: 1,
      updatedBy: "harness",
      flushReason: "stop",
      turnsAtWrite: 0,
    }));
    // Neither anchor field: the record shape written before instructionAction and instructionGoal existed.
    writeFileSync(join(dataDir, "task-state", `${GOAL_LEGACY.botThreadId}.json`), JSON.stringify({
      v: 1,
      threadId: GOAL_LEGACY.botThreadId,
      botId: GOAL_LEGACY.botId,
      goal: "Ship the legacy release",
      plan: [{ step: "Run legacy smoke tests", status: "active" }],
      completed: [],
      evidence: [],
      artifacts: [],
      blockers: [],
      nextAction: "Run legacy smoke tests",
      updatedAt: 1,
      updatedBy: "harness",
      flushReason: "progress",
      turnsAtWrite: 0,
    }));
    for (const [threadId, botId] of [[THREAD_ID, BOT_ID], [CLAUDE_THREAD_ID, CLAUDE_BOT_ID]]) {
      writeFileSync(join(dataDir, "task-state", `${threadId}.json`), JSON.stringify({
        v: 1,
        threadId,
        botId,
        goal: "Ship the release",
        plan: [{ step: "Run smoke tests", status: "active" }],
        completed: [{ note: "Built the installer", at: 1 }],
        evidence: [{ kind: "file", ref: "reports/green.json" }],
        artifacts: [{ ref: "dist/orbit.exe", label: "Windows installer" }],
        blockers: [],
        nextAction: "Run smoke tests",
        updatedAt: 1,
        updatedBy: "harness",
        flushReason: "progress",
        turnsAtWrite: 0,
      }));
    }
    for (const bot of [ASKS_CODEX, ASKS_CLAUDE]) {
      writeFileSync(join(dataDir, "task-state", `${bot.botThreadId}.json`), JSON.stringify({
        v: 1,
        threadId: bot.botThreadId,
        botId: bot.botId,
        goal: "Ship the release",
        plan: [],
        completed: [],
        evidence: [],
        artifacts: [],
        blockers: [],
        nextAction: "",
        asks: [
          { id: "A1", ask: "Review the model picker PR", status: "waiting-for-user", at: 1, changedAt: 1 },
          { id: "A2", ask: "Drop the old skin", status: "declined", at: 1, changedAt: 1 },
          { id: "A3", ask: "Fix the login redirect", status: "building", at: Date.now(), changedAt: Date.now() },
        ],
        updatedAt: 1,
        updatedBy: "bot",
        flushReason: "progress",
        turnsAtWrite: 0,
      }));
    }
    for (const room of [ROOM_ASKS, ROOM_LAUNCH]) writeFileSync(join(dataDir, "task-state", `${room.roomThreadId}.json`), JSON.stringify({
      v: 1,
      threadId: room.roomThreadId,
      botId: room.botId,
      goal: "Ship the room release",
      plan: [],
      completed: [],
      evidence: [],
      artifacts: [],
      blockers: [],
      nextAction: "",
      asks: [1, 2, 3, 4].map((id) => ({ id: `A${id}`, ask: `Room handoff ${id}`, status: "waiting-for-user", ref: `VM ${id} ready`, at: Date.now() - room.days * 24 * 60 * 60 * 1000, changedAt: Date.now() - room.days * 24 * 60 * 60 * 1000 + id })),
      updatedAt: 1,
      updatedBy: "bot",
      flushReason: "progress",
      turnsAtWrite: 0,
    }));
    writeFileSync(join(dataDir, "task-state", `${ROOM_TASK.roomThreadId}.json`), JSON.stringify({
      v: 1,
      threadId: ROOM_TASK.roomThreadId,
      botId: ROOM_TASK.botId,
      goal: "Ship the room release",
      plan: [{ step: "Verify the room package", status: "active" }],
      completed: [{ note: "Built the room installer", at: 1 }],
      evidence: [{ kind: "file", ref: "reports/room-green.json", note: "room checks passed" }],
      artifacts: [{ ref: "dist/room-orbit.exe", label: "Room installer" }],
      blockers: [{ kind: "approval", note: "Awaiting release approval" }],
      nextAction: "Verify the room package",
      instructionAction: "Verify the room package",
      updatedAt: 1,
      updatedBy: "harness",
      flushReason: "progress",
      turnsAtWrite: 0,
    }));

    await startServer();
  }, 30_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    removeTestData(home);
  });

  it.each(CODEX_SWITCH)("keeps covered values on the provider wire after restart and engine switch for $id", async ({ id }) => {
    const route = `/api/bots/${id}`;
    const first = `What did we work on in ${id}?`;
    expect((await api("POST", `${route}/messages`, { text: first })).status).toBe(202);
    await waitFor(async () => existsSync(dumpPath) && (await botById(id))?.busy === false);
    const { calls }: { calls: CodexCall[] } = JSON.parse(readFileSync(dumpPath, "utf8"));
    const sentFirst = codexTurn(calls, first);
    expect(sentFirst?.history ?? sentFirst?.prompt).toContain(COVERED_CONTACT);
    const saved = (await botById(id))?.messages.findLast((message: { kind: string }) => message.kind === "compaction");
    expect(saved?.compaction.summary, "covered contact in the summary field older Wink reads").toContain(COVERED_CONTACT);

    const stopped = waitForExit(child);
    child.send({ type: "openmausbot:shutdown" });
    await stopped;
    await startServer();
    expect((await api("PATCH", route, {
      modelSelection: { mode: "pinned", instanceId: "claude", model: "claude-sonnet-5-5", effort: "low" },
    })).status).toBe(200);

    const promptRow = z.object({ systemPrompt: z.string(), text: z.string() });
    const providerInput = (text: string) => {
      if (!existsSync(claudePromptLogPath)) return "";
      const sent = readFileSync(claudePromptLogPath, "utf8").split("\n").slice(0, -1)
        .map((line) => promptRow.parse(JSON.parse(line)))
        .findLast((line) => line.text.includes(text));
      return sent ? `${sent.text}\n${sent.systemPrompt}` : "";
    };
    const roomText = `Who is handling the release in the ${id} room?`;
    expect((await api("POST", `/api/groups/${switchRoom(id)}/messages`, { text: roomText })).status).toBe(202);
    await waitFor(async () => Boolean(providerInput(roomText)) && (await botById(id))?.busy === false);
    // The full summary takes the summarizer path; this fake engine's summarizer only yields a fallback row, which rooms skip on base too.
    if (id === "restored-switch") {
      expect.soft(providerInput(roomText).includes(COVERED_CONTACT), "covered contact in room handoff").toBe(true);
      expect.soft(providerInput(roomText).includes(LATER_CONTACT), "later contact in room handoff").toBe(true);
    }

    const text = `Who receives the release handoff after the ${id} switch?`;
    expect((await api("POST", `${route}/messages`, { text })).status).toBe(202);
    await waitFor(async () => Boolean(providerInput(text)) && (await botById(id))?.busy === false);
    const prompt = providerInput(text);
    expect(prompt).toContain(LATER_CONTACT);
    expect(prompt).toContain(RECENT_MILESTONE);
    expect(prompt.includes(COVERED_CONTACT), "covered contact in switched Claude input").toBe(true);
  }, 45_000);

  it.each(CODEX_RESTORED)("keeps covered values on the fresh provider thread for $id", async ({ id, hasSessionSystem }) => {
    const text = "Who receives the release handoff?";
    rmSync(dumpPath, { force: true });
    expect((await api("POST", `/api/bots/${id}/messages`, { text })).status).toBe(202);
    await waitFor(async () => existsSync(dumpPath) && (await botById(id))?.busy === false);

    const { calls }: { calls: CodexCall[] } = JSON.parse(readFileSync(dumpPath, "utf8"));
    const methods = calls.map((call) => call.method);
    expect(methods.filter((method) => method === "thread/resume")).toHaveLength(hasSessionSystem ? 1 : 0);
    expect(methods).toContain("thread/start");
    const prompt = codexTurn(calls, text)?.prompt;
    expect(prompt).toContain(hasSessionSystem ? "provider session could not be resumed" : "because your instructions changed");
    expect(prompt).toContain(LATER_CONTACT);
    expect(prompt).toContain(RECENT_MILESTONE);
    expect(prompt).toContain(COVERED_CONTACT);
  });

  it("dispatches a long thread through a driver without generateText", async () => {
    const sent = await api("POST", `/api/bots/${BOT_ID}/messages`, { text: "Continue with final QA" });
    expect(sent.status).toBe(202);

    await expect.poll(() => existsSync(dumpPath), { timeout: 10_000 }).toBe(true);
    await expect.poll(async () => {
      const bot = (await api("GET", "/api/bots")).body.bots.find(
        (candidate: { id: string }) => candidate.id === BOT_ID,
      );
      return bot?.busy;
    }, { timeout: 10_000 }).toBe(false);

    const dump = JSON.parse(readFileSync(dumpPath, "utf8"));
    const turn = dump.calls.find((call: { method: string }) => call.method === "turn/start");
    const prompt = turn.params.input[0].text;
    expect(prompt).toContain("Goal: Ship the release");
    expect(prompt).toContain("reports/green.json");
    expect(prompt).toContain("dist/orbit.exe");
    expect(prompt).toContain("history 0");
    expect(prompt).toContain("history 120");

    const bot = (await api("GET", "/api/bots")).body.bots.find(
      (candidate: { id: string }) => candidate.id === BOT_ID,
    );
    expect(bot.messages.filter((message: { kind: string }) => message.kind === "compaction")).toHaveLength(1);
    expect(bot.messages.some((message: { text?: string }) => message.text === "history 0")).toBe(true);
    expect(JSON.stringify(bot.messages)).not.toContain("cannot summarize it");
  }, 30_000);

  it("does not --resume a fat Claude soak before the first Wink compact", async () => {
    rmSync(claudeDumpPath, { force: true });
    expect((await api("POST", `/api/bots/${CLAUDE_FAT.botId}/messages`, {
      text: "now commit",
    })).status).toBe(202);

    await waitFor(async () => {
      const bot = (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === CLAUDE_FAT.botId,
      );
      return bot?.busy === false;
    });

    const dump = JSON.parse(readFileSync(claudeDumpPath, "utf8"));
    expect(dump.argv).not.toContain("--resume");
    expect(dump.argv).not.toContain(CLAUDE_FAT.fatSession);
    expect(dump.argv).toContain("--session-id");
    const prompt = typeof dump.prompt === "string" ? dump.prompt : JSON.stringify(dump.prompt);
    expect(prompt).toContain("fresh provider session");
    expect(prompt).not.toContain("Wink compacted this conversation");
    expect(prompt).toContain("tree inspected");
  }, 30_000);

  it("names its recorded files after a fresh session, and adds nothing to the next turn", async () => {
    const send = async (text: string) => {
      expect((await api("POST", `/api/bots/${MARKETING.botId}/messages`, { text })).status).toBe(202);
      await waitFor(async () => (await botById(MARKETING.botId))?.busy === false);
    };
    const launch = join(home, "launch");
    const recordedLine = (prompt: string) => prompt.match(/^Recorded files, newest first: (.*)$/m)?.[1]?.split("; ") ?? [];
    rmSync(claudeDumpPath, { force: true });
    await send("post thursday");
    const dump = JSON.parse(readFileSync(claudeDumpPath, "utf8"));
    const fresh = { dump, prompt: String(dump.prompt.message.content) };
    expect(fresh.dump.argv).not.toContain("--resume");
    const shots = Array.from({ length: 11 }, (_, index) => join(launch, "real-shots", `workers-${index + 1}.png`));
    expect(recordedLine(fresh.prompt)).toEqual(expect.arrayContaining([join(launch, "paste", "03-thursday.md"), ...shots]));
    // a path in step text rides in the task record, never on the recorded line
    expect(recordedLine(fresh.prompt)).not.toContain(join(launch, "My Drive", "release.md"));
    expect(fresh.prompt).toContain(`Follow ${join(launch, "My Drive", "release.md")}`);
    expect(fresh.prompt).not.toContain("search_my_chats");
    expect(fresh.dump.mcpConfig.mcpServers.agents.env.OMB_OWNER_CHATS).not.toBe("1");
    await send("and friday?");
    const next = readFileSync(claudePromptLogPath, "utf8").trim().split("\n")
      .map((line) => z.object({ pid: z.number(), text: z.string() }).parse(JSON.parse(line)))
      .filter((line) => line.pid === dump.pid).at(-1)!;
    expect(next.text).toBe("and friday?");
  }, 60_000);

  it("names saved files on an engine switch and adds nothing to the next resumed turn", async () => {
    const send = async (text: string) => {
      expect((await api("POST", `/api/bots/${ENGINE_SWITCH.botId}/messages`, { text })).status).toBe(202);
      await waitFor(async () => (await botById(ENGINE_SWITCH.botId))?.busy === false);
    };
    rmSync(claudeDumpPath, { force: true });
    await send("continue with Claude");
    const dump = JSON.parse(readFileSync(claudeDumpPath, "utf8"));
    expect(dump.argv).not.toContain("--resume");
    const fresh = String(dump.prompt.message.content);
    expect(fresh).toContain("The conversation so far");
    expect(fresh).not.toContain("Wink compacted this conversation");
    await send("what should I do next?");
    const next = readFileSync(claudePromptLogPath, "utf8").trim().split("\n")
      .map((line) => z.object({ pid: z.number(), text: z.string() }).parse(JSON.parse(line)))
      .filter((line) => line.pid === dump.pid).at(-1)!;
    expect(fresh).toContain("real-shots 1 (cover.png)");
    expect(next.text).toBe("what should I do next?");
  }, 30_000);

  it("names saved files on an engine switch after selecting a branch, and adds nothing to the next turn", async () => {
    const send = async (text: string) => {
      expect((await api("POST", `/api/bots/${ENGINE_SWITCH_BRANCH.botId}/messages`, { text })).status).toBe(202);
      await waitFor(async () => (await botById(ENGINE_SWITCH_BRANCH.botId))?.busy === false);
    };
    expect((await api("POST", `/api/bots/${ENGINE_SWITCH_BRANCH.botId}/active-branch`, { messageId: "sa" })).status).toBe(200);
    rmSync(claudeDumpPath, { force: true });
    await send("continue with Claude");
    const dump = JSON.parse(readFileSync(claudeDumpPath, "utf8"));
    expect(dump.argv).not.toContain("--resume");
    const fresh = String(dump.prompt.message.content);
    expect(fresh).toContain("The user rewound this conversation");
    await send("what should I do next?");
    const next = readFileSync(claudePromptLogPath, "utf8").trim().split("\n")
      .map((line) => z.object({ pid: z.number(), text: z.string() }).parse(JSON.parse(line)))
      .filter((line) => line.pid === dump.pid).at(-1)!;
    expect(fresh).toContain("real-shots 1 (cover.png)");
    expect(next.text).toBe("what should I do next?");
  }, 30_000);

  it("sends a warm turn after a long plan update and writes nothing beside the task record", async () => {
    const { botId, threadId } = MARKETING;
    const send = (text: string) => api("POST", `/api/bots/${botId}/messages`, { text });
    const idle = () => waitFor(async () => (await botById(botId))?.busy === false);
    const latest = () => z.object({ pid: z.number(), text: z.string() }).parse(JSON.parse(readFileSync(claudePromptLogPath, "utf8").trim().split("\n").at(-1)!));
    expect((await send("warm the session")).status).toBe(202);
    await idle();
    const steps = Array.from({ length: 20 }, (_, index) => join("planning", `${"weekly-launch-review-".repeat(6)}${index}.md`));
    expect((await botTaskState(botId, threadId, { plan: steps.map((step) => ({ step, status: "pending" as const })) })).status).toBe(200);
    const taskState = join(home, ".orbit", "task-state");
    const files = readdirSync(taskState).sort();
    const warm = latest();
    expect((await send("thanks for the warm plan")).status).toBe(202);
    await idle();
    expect(latest()).toEqual({ pid: warm.pid, text: "thanks for the warm plan" });
    expect(readdirSync(taskState).sort()).toEqual(files);
  }, 30_000);

  it("scrubs a credential from a recorded file label before the row is saved", async () => {
    const { botId, threadId } = MARKETING;
    expect((await api("POST", `/api/bots/${botId}/messages`, { text: "record the weekly launch plan" })).status).toBe(202);
    await waitFor(async () => (await botById(botId))?.busy === false);
    const marker = "ghp_" + "J7k9U3v8N5w2Z6t4X1r0M9s8K7j6H5g4F3d2";
    writeFileSync(join(home, "launch", "plan.md"), "plan");
    expect((await botTaskState(botId, threadId, { artifacts: [{ ref: join(home, "launch", "plan.md"), label: `Plan ${marker}` }] })).status).toBe(200);
    const rows = (await botById(botId)).messages.flatMap((message: { recorded?: { ref: string; label: string }[] }) => message.recorded ?? []);
    expect(rows.some((row: { ref: string }) => row.ref.endsWith("plan.md"))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(marker);
    expect(JSON.stringify(storedTaskPacket(threadId).artifacts)).not.toContain(marker);
  }, 30_000);

  it("still --resumes Stop recovery on an uncompacted fat Claude soak", async () => {
    const system = await seedSessionSystem(CLAUDE_FAT_STOP, CLAUDE_FAT_STOP.fatSession);
    rmSync(claudeDumpPath, { force: true });
    expect((await api("POST", `/api/bots/${CLAUDE_FAT_STOP.botId}/messages`, {
      text: "continue",
    })).status).toBe(202);

    await waitFor(async () => {
      const bot = (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === CLAUDE_FAT_STOP.botId,
      );
      return bot?.busy === false;
    });

    const dump = JSON.parse(readFileSync(claudeDumpPath, "utf8"));
    expect(dump.argv).toContain("--resume");
    expect(dump.argv).toContain(CLAUDE_FAT_STOP.fatSession);
    const prompt = typeof dump.prompt === "string" ? dump.prompt : JSON.stringify(dump.prompt);
    expect(prompt).not.toContain("fresh provider session");
    expect(prompt).not.toContain("Wink compacted this conversation");
    // the seeded record was exactly what this turn sent, so nothing changed to remind
    expect(dump.systemPrompt).toBe(system);
    expect(prompt).not.toContain("<system-reminder>");
  }, 30_000);

  it("still --resumes a short uncompacted Claude thread", async () => {
    const system = await seedSessionSystem(CLAUDE_SLIM, CLAUDE_SLIM.session);
    rmSync(claudeDumpPath, { force: true });
    expect((await api("POST", `/api/bots/${CLAUDE_SLIM.botId}/messages`, {
      text: "thanks",
    })).status).toBe(202);

    await waitFor(async () => {
      const bot = (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === CLAUDE_SLIM.botId,
      );
      return bot?.busy === false;
    });

    const dump = JSON.parse(readFileSync(claudeDumpPath, "utf8"));
    expect(dump.argv).toContain("--resume");
    expect(dump.argv).toContain(CLAUDE_SLIM.session);
    const prompt = typeof dump.prompt === "string" ? dump.prompt : JSON.stringify(dump.prompt);
    expect(prompt).not.toContain("[Wink memory");
    expect(prompt).not.toContain("fresh provider session");
    expect(prompt).not.toContain("Wink compacted this conversation");
    expect(dump.systemPrompt).toBe(system);
    expect(prompt).not.toContain("<system-reminder>");
  }, 30_000);

  it("starts a session with no system record fresh once, then resumes the new one", async () => {
    expect(existsSync(sessionSystemPath(CLAUDE_UPDATE_DAY.session))).toBe(false);
    rmSync(claudeDumpPath, { force: true });
    expect((await api("POST", `/api/bots/${CLAUDE_UPDATE_DAY.botId}/messages`, {
      text: "thanks",
    })).status).toBe(202);
    await waitFor(async () => (await botById(CLAUDE_UPDATE_DAY.botId))?.busy === false);

    const fresh = JSON.parse(readFileSync(claudeDumpPath, "utf8"));
    expect(fresh.argv).not.toContain("--resume");
    expect(fresh.argv).not.toContain(CLAUDE_UPDATE_DAY.session);
    expect(fresh.argv).toContain("--session-id");
    const freshPrompt = JSON.stringify(fresh.prompt);
    expect(freshPrompt).toContain("Wink started a fresh provider session because your instructions changed");
    expect(freshPrompt).toContain("hello");
    const session = fresh.argv[fresh.argv.indexOf("--session-id") + 1];
    expect(readFileSync(sessionSystemPath(session), "utf8")).toBe(fresh.systemPrompt);

    expect((await api("POST", `/api/bots/${CLAUDE_UPDATE_DAY.botId}/messages`, {
      text: "one more thing",
    })).status).toBe(202);
    await waitFor(async () => (await botById(CLAUDE_UPDATE_DAY.botId))?.busy === false);

    // The driver hands a turn to its idle CLI only when the harness names that
    // CLI's session as the resume cursor; any other cursor spawns a new one.
    const sent = readFileSync(claudePromptLogPath, "utf8").trim().split("\n")
      .map((line) => z.object({ pid: z.number(), argv: z.array(z.string()), text: z.string() }).parse(JSON.parse(line)))
      .filter((line) => line.pid === fresh.pid);
    expect(sent).toHaveLength(2);
    const resumed = sent[1];
    expect(resumed.argv).toContain(session);
    expect(resumed.text).toContain("one more thing");
    expect(resumed.text).not.toContain("fresh provider session");
    expect(resumed.text).not.toContain("<system-reminder>");
  }, 30_000);

  it("does not --resume a stale Claude session after Wink compaction", async () => {
    rmSync(claudeDumpPath, { force: true });
    expect((await api("POST", `/api/bots/${CLAUDE_RESUME.botId}/messages`, {
      text: "Continue with final QA",
    })).status).toBe(202);

    await waitFor(async () => {
      const bot = (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === CLAUDE_RESUME.botId,
      );
      return bot?.busy === false;
    });

    const dump = JSON.parse(readFileSync(claudeDumpPath, "utf8"));
    expect(dump.argv).not.toContain("--resume");
    expect(dump.argv).not.toContain(CLAUDE_RESUME.fatSession);
    expect(dump.argv).toContain("--session-id");
    const prompt = typeof dump.prompt === "string"
      ? dump.prompt
      : JSON.stringify(dump.prompt);
    expect(prompt).toContain("Wink compacted this conversation");
    expect(prompt).toMatch(/history 0|Wink durable context summary/);
  }, 30_000);

  it("queues another turn while generated compaction is preparing", async () => {
    rmSync(claudeDumpPath, { force: true });
    const first = api("POST", `/api/bots/${CLAUDE_BOT_ID}/messages`, { text: "Start final QA" });
    await expect.poll(() => existsSync(claudeDumpPath), { timeout: 10_000 }).toBe(true);

    const second = await api("POST", `/api/bots/${CLAUDE_BOT_ID}/messages`, { text: "Start packaging too" });
    expect(second.status).toBe(202);
    expect(second.body.queued).toBe(true);
    await expect(first).resolves.toMatchObject({ status: 202 });

    await waitFor(async () => {
      const bot = (await api("GET", "/api/bots")).body.bots.find(
        (candidate: { id: string }) => candidate.id === CLAUDE_BOT_ID,
      );
      return bot?.busy === false && bot.messages.some((message: { text?: string }) => message.text === "Start packaging too");
    });
    const bot = (await api("GET", "/api/bots")).body.bots.find(
      (candidate: { id: string }) => candidate.id === CLAUDE_BOT_ID,
    );
    expect(bot.messages.filter((message: { text?: string }) => message.text === "Start final QA")).toHaveLength(1);
    expect(bot.messages.filter((message: { text?: string }) => message.text === "Start packaging too")).toHaveLength(1);
  }, 30_000);

  it("queues a 1:1 turn while the same bot is preparing room context", async () => {
    rmSync(claudeDumpPath, { force: true });
    const room = await api("POST", `/api/groups/${ROOM_FIRST.groupId}/messages`, { text: "Start room QA" });
    expect(room.status).toBe(202);
    await expect.poll(() => existsSync(claudeDumpPath), { timeout: 10_000 }).toBe(true);

    const direct = await api("POST", `/api/bots/${ROOM_FIRST.botId}/messages`, { text: "Start direct QA too" });
    await waitFor(async () => {
      const state = (await api("GET", "/api/bots")).body;
      const bot = state.bots.find((candidate: { id: string }) => candidate.id === ROOM_FIRST.botId);
      const group = state.groups.find((candidate: { id: string }) => candidate.id === ROOM_FIRST.groupId);
      return bot?.busy === false && group?.working === false
        && bot.messages.some((message: { text?: string }) => message.text === "Start direct QA too");
    });

    expect(direct.status).toBe(202);
    expect(direct.body.queued).toBe(true);
    const state = (await api("GET", "/api/bots")).body;
    const bot = state.bots.find((candidate: { id: string }) => candidate.id === ROOM_FIRST.botId);
    expect(bot.messages.filter((message: { text?: string }) => message.text === "Start direct QA too")).toHaveLength(1);
    expect(storedTaskPacket(ROOM_FIRST.roomThreadId)).toMatchObject({
      threadId: ROOM_FIRST.roomThreadId,
      botId: ROOM_FIRST.botId,
      goal: "Start room QA",
      nextAction: "Start room QA",
    });
  }, 30_000);

  it("queues a room turn while the same bot is preparing 1:1 context", async () => {
    rmSync(claudeDumpPath, { force: true });
    const direct = api("POST", `/api/bots/${DIRECT_FIRST.botId}/messages`, { text: "Start direct QA" });
    await expect.poll(() => existsSync(claudeDumpPath), { timeout: 10_000 }).toBe(true);

    const room = await api("POST", `/api/groups/${DIRECT_FIRST.groupId}/messages`, { text: "Start room QA too" });
    const directResult = await direct;
    await waitFor(async () => {
      const state = (await api("GET", "/api/bots")).body;
      const bot = state.bots.find((candidate: { id: string }) => candidate.id === DIRECT_FIRST.botId);
      const group = state.groups.find((candidate: { id: string }) => candidate.id === DIRECT_FIRST.groupId);
      return bot?.busy === false && group?.working === false;
    });

    expect(directResult.status).toBe(202);
    expect(room.status).toBe(202);
    const state = (await api("GET", "/api/bots")).body;
    const group = state.groups.find((candidate: { id: string }) => candidate.id === DIRECT_FIRST.groupId);
    const skipped = group.messages.find(
      (message: { tool?: { name?: string } }) => message.tool?.name?.includes("skipped this round"),
    );
    expect(skipped).toBeUndefined();
    const roomReplies = group.messages.filter(
      (message: { role?: string; kind?: string; from?: { botId?: string } }) =>
        message.role === "bot" && message.kind === "text" && message.from?.botId === DIRECT_FIRST.botId,
    );
    expect(roomReplies).toHaveLength(1);
  }, 30_000);

  it("rejects an edit claim before branching the thread", async () => {
    rmSync(claudeDumpPath, { force: true });
    const first = api("POST", `/api/bots/${EDIT_CLAIM.botId}/messages`, { text: "Start guarded edit QA" });
    await expect.poll(() => existsSync(claudeDumpPath), { timeout: 10_000 }).toBe(true);

    const before = (await api("GET", "/api/bots")).body.bots.find(
      (candidate: { id: string }) => candidate.id === EDIT_CLAIM.botId,
    );
    const edited = await api("POST", `/api/bots/${EDIT_CLAIM.botId}/messages/m0/edit`, {
      text: "mutated while preparing",
    });

    expect(edited.status).toBe(409);
    const after = (await api("GET", "/api/bots")).body.bots.find(
      (candidate: { id: string }) => candidate.id === EDIT_CLAIM.botId,
    );
    expect(after.activeLeafId).toBe(before.activeLeafId);
    expect(after.messages.some((message: { text?: string }) => message.text === "mutated while preparing")).toBe(false);
    await expect(first).resolves.toMatchObject({ status: 202 });
    await waitFor(async () => {
      const bot = (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === EDIT_CLAIM.botId,
      );
      return bot?.busy === false;
    });
  }, 30_000);

  it("rejects a new task claim before switching threads", async () => {
    rmSync(claudeDumpPath, { force: true });
    const first = api("POST", `/api/bots/${NEW_TASK_CLAIM.botId}/messages`, { text: "Start guarded task QA" });
    await expect.poll(() => existsSync(claudeDumpPath), { timeout: 10_000 }).toBe(true);

    const before = (await api("GET", "/api/bots?messages=0")).body.bots.find(
      (candidate: { id: string }) => candidate.id === NEW_TASK_CLAIM.botId,
    );
    const created = await api("POST", `/api/bots/${NEW_TASK_CLAIM.botId}/tasks`, { title: "Too soon" });

    expect(created.status).toBe(409);
    const after = (await api("GET", "/api/bots?messages=0")).body.bots.find(
      (candidate: { id: string }) => candidate.id === NEW_TASK_CLAIM.botId,
    );
    expect(after.threadId).toBe(before.threadId);
    expect(after.tasks).toHaveLength(before.tasks.length);
    await expect(first).resolves.toMatchObject({ status: 202 });
    await waitFor(async () => {
      const bot = (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === NEW_TASK_CLAIM.botId,
      );
      return bot?.busy === false;
    });
  }, 30_000);

  it("queues a room credential continuation after a claim collision", async () => {
    rmSync(claudeDumpPath, { force: true });
    expect((await api("POST", `/api/groups/${SECRET_COLLISION.groupId}/messages`, {
      text: "Open the room session",
    })).status).toBe(202);
    await expect.poll(() => existsSync(claudeDumpPath), { timeout: 10_000 }).toBe(true);
    await waitFor(async () => {
      const group = (await api("GET", "/api/bots?messages=0")).body.groups.find(
        (candidate: { id: string }) => candidate.id === SECRET_COLLISION.groupId,
      );
      return group?.working === false;
    });
    const dump = JSON.parse(readFileSync(claudeDumpPath, "utf8"));
    const token = dump.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
    const beforeReplies = (await api("GET", "/api/bots")).body.groups
      .find((candidate: { id: string }) => candidate.id === SECRET_COLLISION.groupId)
      .messages.filter((message: { role: string; kind: string }) => message.role === "bot" && message.kind === "text").length;

    const requested = await fetch(`${BASE}/api/internal/request-credential`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        fromBotId: SECRET_COLLISION.botId,
        fromThreadId: SECRET_COLLISION.roomThreadId,
        credentialId: "openaiImageApiKey",
        reason: "needed for retry coverage",
      }),
    });
    expect(requested.status).toBe(201);
    const { messageId } = z.object({ messageId: z.string() }).parse(await requested.json());

    rmSync(claudeDumpPath, { force: true });
    const direct = api("POST", `/api/bots/${SECRET_COLLISION.botId}/messages`, {
      text: "Hold the direct claim",
    });
    await expect.poll(() => existsSync(claudeDumpPath), { timeout: 10_000 }).toBe(true);
    expect((await api("POST", `/api/bots/${SECRET_COLLISION.botId}/secret-cards/${messageId}/dismiss`, {
      threadId: SECRET_COLLISION.roomThreadId,
    })).status).toBe(200);

    await expect(direct).resolves.toMatchObject({ status: 202 });
    await waitFor(async () => {
      const state = (await api("GET", "/api/bots")).body;
      const bot = state.bots.find((candidate: { id: string }) => candidate.id === SECRET_COLLISION.botId);
      const group = state.groups.find((candidate: { id: string }) => candidate.id === SECRET_COLLISION.groupId);
      const replies = group.messages.filter(
        (message: { role: string; kind: string }) => message.role === "bot" && message.kind === "text",
      );
      return bot?.busy === false && group?.working === false && replies.length > beforeReplies;
    });

    const group = (await api("GET", "/api/bots")).body.groups
      .find((candidate: { id: string }) => candidate.id === SECRET_COLLISION.groupId);
    expect(group.messages.some(
      (message: { tool?: { name?: string } }) => message.tool?.name?.includes("skipped this round"),
    )).toBe(false);
    const collided = group.messages.find((message: { id: string }) => message.id === messageId);
    expect(collided.secret).toMatchObject({ dismissed: true });
    expect(collided.secret.error).toBeUndefined();
  }, 40_000);

  it("flushes and injects the room task record before compaction", async () => {
    const beforeOwnerRemoval = storedTaskPacket(ROOM_TASK.roomThreadId);
    expect((await api("PATCH", `/api/groups/${ROOM_TASK.groupId}`, {
      memberIds: [ROOM_TASK_NEXT.botId, ROOM_TASK_SURVIVOR.botId],
    })).status).toBe(200);
    expect(storedTaskPacket(ROOM_TASK.roomThreadId)).toEqual({
      ...beforeOwnerRemoval,
      botId: ROOM_TASK_NEXT.botId,
    });

    rmSync(dumpPath, { force: true });
    expect((await api("POST", `/api/groups/${ROOM_TASK.groupId}/messages`, {
      text: `Continue after the packet owner left ${"detail ".repeat(6_000)}`,
    })).status).toBe(202);
    await expect.poll(() => existsSync(dumpPath), { timeout: 10_000 }).toBe(true);
    await waitFor(async () => {
      const group = (await api("GET", "/api/bots?messages=0")).body.groups.find(
        (candidate: { id: string }) => candidate.id === ROOM_TASK.groupId,
      );
      return group?.working === false;
    });
    const afterOwnerRemovalDump = JSON.parse(readFileSync(dumpPath, "utf8"));
    const afterOwnerRemovalTurn = afterOwnerRemovalDump.calls
      .filter((call: { method: string }) => call.method === "turn/start").at(-1);
    const afterOwnerRemovalPrompt = afterOwnerRemovalTurn.params.input[0].text;
    for (const preserved of [
      "Goal: Ship the room release",
      "active: Verify the room package",
      "Done recently: 1 total; Built the room installer",
      "file: reports/room-green.json (room checks passed)",
      "Room installer: dist/room-orbit.exe",
      "Blockers: 1 total; Awaiting release approval",
      "Next action: Continue after the packet owner left",
    ]) expect(afterOwnerRemovalPrompt).toContain(preserved);

    const beforeOwnerDeletion = storedTaskPacket(ROOM_TASK.roomThreadId);
    expect((await api("DELETE", `/api/bots/${ROOM_TASK_NEXT.botId}`)).status).toBe(200);
    expect(storedTaskPacket(ROOM_TASK.roomThreadId)).toEqual({
      ...beforeOwnerDeletion,
      botId: ROOM_TASK_SURVIVOR.botId,
    });

    rmSync(dumpPath, { force: true });
    expect((await api("POST", `/api/groups/${ROOM_TASK.groupId}/messages`, {
      text: `@Survivor continue after the packet owner was deleted ${"detail ".repeat(6_000)}`,
    })).status).toBe(202);
    await expect.poll(() => existsSync(dumpPath), { timeout: 10_000 }).toBe(true);
    await waitFor(async () => {
      const group = (await api("GET", "/api/bots?messages=0")).body.groups.find(
        (candidate: { id: string }) => candidate.id === ROOM_TASK.groupId,
      );
      return group?.working === false;
    });
    const afterOwnerDeletionDump = JSON.parse(readFileSync(dumpPath, "utf8"));
    const afterOwnerDeletionTurn = afterOwnerDeletionDump.calls
      .filter((call: { method: string }) => call.method === "turn/start").at(-1);
    const afterOwnerDeletionPrompt = afterOwnerDeletionTurn.params.input[0].text;
    for (const preserved of [
      "Goal: Ship the room release",
      "active: Verify the room package",
      "Done recently: 1 total; Built the room installer",
      "file: reports/room-green.json (room checks passed)",
      "Room installer: dist/room-orbit.exe",
      "Blockers: 1 total; Awaiting release approval",
      "Next action: @Survivor continue after the packet owner was deleted",
    ]) expect(afterOwnerDeletionPrompt).toContain(preserved);
    expect(storedTaskPacket(ROOM_TASK.roomThreadId)).toMatchObject({
      botId: ROOM_TASK_SURVIVOR.botId,
      threadId: ROOM_TASK.roomThreadId,
      flushReason: "progress",
    });
  }, 30_000);

  it("keeps the folder cleared when Settings Clear lands while a turn is preparing", async () => {
    rmSync(claudeDumpPath, { force: true });
    const send = api("POST", `/api/bots/${CLEAR_RACE.botId}/messages`, {
      text: `add tests in ${clearRaceProject}`,
    });
    // the summarizer is running: the send is persisted, the folder not yet resolved
    await expect.poll(() => existsSync(claudeDumpPath), { timeout: 10_000 }).toBe(true);
    const cleared = await api("PATCH", `/api/bots/${CLEAR_RACE.botId}`, { cwd: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.bot.rememberedProjectCwd).toBeNull();
    await expect(send).resolves.toMatchObject({ status: 202 });

    await waitFor(async () => {
      const bot = (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === CLEAR_RACE.botId,
      );
      return bot?.busy === false;
    });
    const bot = (await api("GET", "/api/bots?messages=0")).body.bots.find(
      (candidate: { id: string }) => candidate.id === CLEAR_RACE.botId,
    );
    expect(bot.cwd).toBeNull();
    expect(bot.rememberedProjectCwd).toBeNull();
    expect(bot.tasks[0].cwd).not.toContain("clear-race-project");
  }, 30_000);

  it("moves the continuity goal to the newest instruction", async () => {
    const first = await api("POST", `/api/bots/${GOAL_STRIP.botId}/messages`, {
      text: "Say hello in one short sentence.",
    });
    expect(first.status).toBe(202);
    expect(storedTaskPacket(GOAL_STRIP.botThreadId).goal).toBe("Say hello in one short sentence.");
    await waitFor(async () => (await botById(GOAL_STRIP.botId))?.busy === false);

    const second = await api("POST", `/api/bots/${GOAL_STRIP.botId}/messages`, {
      text: "Draft the outage timeline from the scanned exhibits.",
    });
    expect(second.status).toBe(202);
    // The 202 lands after the instruction is folded and before the turn settles:
    // the same in-flight window the strip renders the goal in.
    expect(storedTaskPacket(GOAL_STRIP.botThreadId).goal).toBe("Draft the outage timeline from the scanned exhibits.");
    await waitFor(async () => (await botById(GOAL_STRIP.botId))?.busy === false);

    const packet = storedTaskPacket(GOAL_STRIP.botThreadId);
    expect(packet.goal).toBe("Draft the outage timeline from the scanned exhibits.");
    // The anchor must survive the re-seed, or completion takes #112's always-blank path.
    expect(packet.instructionAction).toBe("Draft the outage timeline from the scanned exhibits.");
  }, 30_000);

  it("leaves a pre-anchor record's goal where it was", async () => {
    const sent = await api("POST", `/api/bots/${GOAL_LEGACY.botId}/messages`, {
      text: "Draft the outage timeline from the scanned exhibits.",
    });
    expect(sent.status).toBe(202);
    await waitFor(async () => (await botById(GOAL_LEGACY.botId))?.busy === false);

    const packet = storedTaskPacket(GOAL_LEGACY.botThreadId);
    expect(packet.goal).toBe("Ship the legacy release");
    expect(packet.instructionGoal).toBeUndefined();
    expect(packet.instructionAction).toBeUndefined();
  }, 30_000);

  it("keeps a goal the bot set through update_task_state when its text matched the seed", async () => {
    rmSync(claudeDumpPath, { force: true });
    expect((await api("POST", `/api/bots/${GOAL_OWNED.botId}/messages`, {
      text: "Say hello in one short sentence.",
    })).status).toBe(202);
    await waitFor(async () => (await botById(GOAL_OWNED.botId))?.busy === false);

    // Confirming the task by echoing the seeded goal verbatim still claims it.
    const saved = await botTaskState(GOAL_OWNED.botId, GOAL_OWNED.botThreadId, {
      goal: "Say hello in one short sentence.",
      plan: [{ step: "Greet the user", status: "active" }],
    });
    expect(saved.status).toBe(200);

    expect((await api("POST", `/api/bots/${GOAL_OWNED.botId}/messages`, {
      text: "What's the status?",
    })).status).toBe(202);
    const packet = storedTaskPacket(GOAL_OWNED.botThreadId);
    expect(packet.goal).toBe("Say hello in one short sentence.");
    expect(packet.plan).toEqual([{ step: "Greet the user", status: "active" }]);
    expect(packet.instructionAction).toBe("What's the status?");
    await waitFor(async () => (await botById(GOAL_OWNED.botId))?.busy === false);
  }, 30_000);

  it("re-seeds the harness plan with the goal it was derived from", async () => {
    rmSync(claudeDumpPath, { force: true });
    expect((await api("POST", `/api/bots/${PLAN_SEED.botId}/messages`, {
      text: "Say hello in one short sentence.",
    })).status).toBe(202);
    await waitFor(async () => (await botById(PLAN_SEED.botId))?.busy === false);
    expect(storedTaskPacket(PLAN_SEED.botThreadId).plan).toEqual([
      { step: "Say hello in one short sentence.", status: "active" },
    ]);

    expect((await api("POST", `/api/bots/${PLAN_SEED.botId}/messages`, {
      text: "Draft the outage timeline from the scanned exhibits.",
    })).status).toBe(202);
    // The record the model is handed must not read Goal: <new> beside Plan: active: <first>.
    const packet = storedTaskPacket(PLAN_SEED.botThreadId);
    expect(packet.goal).toBe("Draft the outage timeline from the scanned exhibits.");
    expect(packet.plan).toEqual([
      { step: "Draft the outage timeline from the scanned exhibits.", status: "active" },
    ]);
    expect(packet.instructionAction).toBe("Draft the outage timeline from the scanned exhibits.");
    await waitFor(async () => (await botById(PLAN_SEED.botId))?.busy === false);
  }, 30_000);

  it("re-seeds the goal after a bot sends only a plan", async () => {
    rmSync(claudeDumpPath, { force: true });
    expect((await api("POST", `/api/bots/${PLAN_ONLY.botId}/messages`, {
      text: "Say hello.",
    })).status).toBe(202);
    await waitFor(async () => (await botById(PLAN_ONLY.botId))?.busy === false);

    // update_task_state tells the bot to omit an unchanged goal, so plan-only is the normal call.
    expect((await botTaskState(PLAN_ONLY.botId, PLAN_ONLY.botThreadId, {
      plan: [
        { step: "Cut the release branch", status: "done" },
        { step: "Sign the installers", status: "active" },
      ],
    })).status).toBe(200);

    expect((await api("POST", `/api/bots/${PLAN_ONLY.botId}/messages`, {
      text: "Now draft the outage timeline.",
    })).status).toBe(202);
    const packet = storedTaskPacket(PLAN_ONLY.botThreadId);
    // A plan write claims the plan alone: the goal is still the harness's guess.
    expect(packet.goal).toBe("Now draft the outage timeline.");
    expect(packet.plan).toEqual([
      { step: "Cut the release branch", status: "done" },
      { step: "Sign the installers", status: "active" },
    ]);
    expect(packet.instructionAction).toBe("Now draft the outage timeline.");
    await waitFor(async () => (await botById(PLAN_ONLY.botId))?.busy === false);
  }, 30_000);

  it("keeps the seeded plan step mirroring a goal the bot set", async () => {
    rmSync(claudeDumpPath, { force: true });
    expect((await api("POST", `/api/bots/${GOAL_ONLY.botId}/messages`, {
      text: "Ship the release.",
    })).status).toBe(202);
    await waitFor(async () => (await botById(GOAL_ONLY.botId))?.busy === false);

    expect((await botTaskState(GOAL_ONLY.botId, GOAL_ONLY.botThreadId, {
      goal: "Ship the 2.1 release with signed installers",
    })).status).toBe(200);

    expect((await api("POST", `/api/bots/${GOAL_ONLY.botId}/messages`, {
      text: "What's the status?",
    })).status).toBe(202);
    const packet = storedTaskPacket(GOAL_ONLY.botThreadId);
    // Never Goal: Ship the 2.1 release beside Plan: active: What's the status?
    expect(packet.goal).toBe("Ship the 2.1 release with signed installers");
    expect(packet.plan).toEqual([
      { step: "Ship the 2.1 release with signed installers", status: "active" },
    ]);
    expect(packet.instructionAction).toBe("What's the status?");
    await waitFor(async () => (await botById(GOAL_ONLY.botId))?.busy === false);
  }, 30_000);

  it("anchors a plan the harness regenerates after the bot cleared it", async () => {
    rmSync(claudeDumpPath, { force: true });
    expect((await api("POST", `/api/bots/${PLAN_CLEARED.botId}/messages`, {
      text: "Ship the release.",
    })).status).toBe(202);
    await waitFor(async () => (await botById(PLAN_CLEARED.botId))?.busy === false);

    expect((await botTaskState(PLAN_CLEARED.botId, PLAN_CLEARED.botThreadId, { plan: [] })).status).toBe(200);
    expect(storedTaskPacket(PLAN_CLEARED.botThreadId).plan).toEqual([]);

    expect((await api("POST", `/api/bots/${PLAN_CLEARED.botId}/messages`, {
      text: "Draft the outage timeline.",
    })).status).toBe(202);
    await waitFor(async () => (await botById(PLAN_CLEARED.botId))?.busy === false);

    expect((await api("POST", `/api/bots/${PLAN_CLEARED.botId}/messages`, {
      text: "Sign the installers.",
    })).status).toBe(202);
    // The regenerated step must carry its anchor, or it freezes while nextAction moves on.
    const packet = storedTaskPacket(PLAN_CLEARED.botThreadId);
    expect(packet.plan).toEqual([{ step: "Sign the installers.", status: "active" }]);
    expect(packet.instructionStep).toBe("Sign the installers.");
    expect(packet.instructionAction).toBe("Sign the installers.");
    await waitFor(async () => (await botById(PLAN_CLEARED.botId))?.busy === false);
  }, 30_000);

  it.each([ASKS_CODEX, ASKS_CLAUDE])("keeps $name asks across compaction, flags the one needing a verdict and closes into history", async (bot) => {
    // Null until the engine has run this turn. A warm Claude process logs each later prompt but dumps once.
    const sent = (text: string) => {
      try {
        if (bot.selection.instanceId === "claude") {
          const logged = readFileSync(claudePromptLogPath, "utf8").trim().split("\n")
            .map((line) => JSON.parse(line) as { systemPrompt: string; text: string })
            .filter((line) => line.text.includes(text)).at(-1);
          const dump = JSON.parse(readFileSync(claudeDumpPath, "utf8"));
          if (!logged || !dump.mcpConfig) return null;
          return {
            prompt: logged.text,
            system: logged.systemPrompt,
            tools: JSON.stringify(dump.mcpConfig.mcpServers.agents),
            token: String(dump.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN),
          };
        }
        const dump = JSON.parse(readFileSync(dumpPath, "utf8"));
        const calls: Array<{ method: string; params: any }> = dump.calls;
        const prompt = calls.filter((call) => call.method === "turn/start" && JSON.stringify(call.params.input).includes(text)).at(-1)?.params.input[0].text;
        if (!prompt) return null;
        return {
          prompt: String(prompt),
          system: String(calls.find((call) => call.method === "thread/start" && String(call.params.developerInstructions).includes(`You are ${bot.name},`))?.params.developerInstructions),
          tools: String(dump.argv.find((arg: string) => arg.startsWith("mcp_servers.agents.args="))),
          token: String(dump.env.WINK_MCP_AGENTS_OMB_COMMS_TOKEN),
        };
      } catch {
        return null;
      }
    };
    const turn = async (text: string) => {
      expect((await api("POST", `/api/bots/${bot.botId}/messages`, { text })).status).toBe(202);
      await waitFor(async () => sent(text) !== null && (await botById(bot.botId))?.busy === false);
      return sent(text)!;
    };

    rmSync(claudeDumpPath, { force: true });
    const compacted = await turn(`${bot.name}: continue the release`);
    expect(compacted.prompt).toContain("history 120");
    expect(compacted.prompt).toContain("[Wink asks list - 2 open, 1 needs a verdict: no ref and no change in 3+ days");
    expect(compacted.prompt).toContain("- A1 waiting-for-user needs verdict ");
    expect(compacted.prompt).toContain(": Review the model picker PR\n");
    expect(compacted.prompt).toContain("- A3 building ");
    expect(compacted.prompt).not.toContain("Drop the old skin");
    expect(compacted.system).toContain("Add each ask the user makes to update_task_state asks in the same turn");
    expect(compacted.tools).toContain("agents-proxy");

    const resumed = await turn(`${bot.name}: thanks`);
    expect(resumed.prompt, "a shown verdict row rests").toContain("- A1 waiting-for-user 01-01: Review the model picker PR");

    const closed = await botTaskState(bot.botId, bot.botThreadId, { asks: [{ id: "A1", status: "done" }] }, resumed.token);
    expect(closed.status).toBe(200);
    expect(z.object({ notice: z.string() }).parse(await closed.json()).notice).toBe("Asks saved; 1 open.");
    expect(storedTaskPacket(bot.botThreadId).asks.map((ask: { id: string; status: string }) => `${ask.id} ${ask.status}`))
      .toEqual(["A1 done", "A2 declined", "A3 building"]);

    const morning = await turn(`${bot.name}: morning, where are we?`);
    expect(morning.prompt).toContain("[Wink asks list - 1 open. Build any summary or status from this list.]\n- A3 building ");
  }, 60_000);

  it("brings a room's newest asks waiting on the user to a typed done", async () => {
    const logged = () => existsSync(claudePromptLogPath) ? readFileSync(claudePromptLogPath, "utf8").split("\n").slice(0, -1) : [];
    const before = logged().length;
    expect((await api("POST", `/api/groups/${ROOM_ASKS.groupId}/messages`, { text: "done" })).status).toBe(202);
    await waitFor(async () => logged().length > before && (await botById(ROOM_ASKS.botId))?.busy === false);
    const prompt = z.object({ text: z.string() }).parse(JSON.parse(logged()[before]!)).text;
    expect(prompt).toContain("[Wink asks waiting on the user - 4 open, newest first.");
    expect(prompt).toContain("- A4 waiting-for-user ");
    expect(prompt).toContain(": Room handoff 2 (VM 2 ready)\n- +1 more waiting on the user");
    expect(prompt).not.toContain("- A1 waiting-for-user ");
  }, 30_000);

  it("keeps the verdict rows a failed room launch never delivered for the next reply", async () => {
    const logged = () => existsSync(claudePromptLogPath) ? readFileSync(claudePromptLogPath, "utf8").split("\n").slice(0, -1) : [];
    const rested = () => storedTaskPacket(ROOM_LAUNCH.roomThreadId).asks.filter((item: { shown?: number }) => item.shown !== undefined).map((item: { id: string }) => item.id);
    const room = async () => (await api("GET", "/api/bots")).body.groups.find((group: { id: string }) => group.id === ROOM_LAUNCH.groupId);
    expect((await api("POST", `/api/groups/${ROOM_LAUNCH.groupId}/messages`, { text: "done" })).status).toBe(202);
    await waitFor(async () => (await room()).working === false && (await room()).messages.some((message: { tool?: { name: string } }) => message.tool?.name.startsWith("error: ")));
    expect(rested()).toEqual([]);
    expect((await api("PATCH", `/api/bots/${ROOM_LAUNCH.botId}`, { modelSelection: { mode: "pinned", instanceId: "claude", model: "claude-fake", effort: "low" } })).status).toBe(200);
    const before = logged().length;
    expect((await api("POST", `/api/groups/${ROOM_LAUNCH.groupId}/messages`, { text: "done" })).status).toBe(202);
    await waitFor(async () => logged().length > before && (await room()).working === false);
    const prompt = z.object({ text: z.string() }).parse(JSON.parse(logged()[before]!)).text;
    for (const id of ["A1", "A2", "A3"]) expect(prompt).toContain(`- ${id} waiting-for-user needs verdict `);
    await waitFor(async () => rested().join() === "A1,A2,A3");
  }, 30_000);
});
