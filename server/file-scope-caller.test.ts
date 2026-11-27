import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CommsCallers } from "./comms-caller.ts";
import { createInternalRoutes } from "./internal-routes.ts";
import { seedTaskResumePacket } from "./task-state-fold.ts";
import type { TaskResumePacket } from "./task-state.ts";

// bot-a's chat is a read-only (guest) turn; bot-b's chat is the owner's own, working turn.
const callers = new CommsCallers();
const bots: Record<string, { id: string; name: string; threadId: string }> = {
  "bot-a": { id: "bot-a", name: "A", threadId: "chat-a" },
  "bot-b": { id: "bot-b", name: "B", threadId: "chat-b" },
};

let dir: string;
let taskDir: string;
let outside: string;
let packets: Map<string, TaskResumePacket>;
let routes: ReturnType<typeof createInternalRoutes>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "file-scope-caller-"));
  taskDir = join(dir, "task");
  outside = join(dir, "outside.txt");
  mkdirSync(taskDir);
  writeFileSync(outside, "private");
  packets = new Map(Object.values(bots).map((bot) => [bot.threadId, seedTaskResumePacket({ threadId: bot.threadId, botId: bot.id, text: "Build the site", messageId: "m", now: 1, turnsAtWrite: 0 })]));
  const owns = (botId: string, threadId: string) => (bots[botId]?.threadId === threadId ? {} : undefined);
  routes = createInternalRoutes({
    store: {
      bot: (id: string) => bots[id],
      conversationForBot: owns,
      taskByThread: () => ({ cwd: taskDir }),
      groupTaskByThread: () => undefined,
    },
    connectorThread: owns,
    taskPacketForWrite: (threadId: string) => structuredClone(packets.get(threadId)!),
    persistTaskPacket: (next: TaskResumePacket) => (packets.set(next.threadId, next), next),
    readOnlyTurn: (_botId: string, threadId: string) => threadId === "chat-a",
    resolveCommsCaller: (header: string | string[] | undefined) => callers.resolve(header),
  } as unknown as Parameters<typeof createInternalRoutes>[0]);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function post(route: "taskState" | "showImage", token: [string, string] | null, body: object) {
  const req = new EventEmitter() as IncomingMessage;
  req.headers = token ? { authorization: `Bearer ${callers.token(...token)}` } : {};
  let status = 0;
  let out = "";
  const res = { writeHead(code: number) { status = code; }, getHeader() {}, setHeader() {}, end(value: string) { out = value; } } as unknown as ServerResponse;
  const pending = routes[route](req, res);
  req.emit("data", JSON.stringify(body));
  req.emit("end");
  await pending;
  return { status, error: (JSON.parse(out || "{}") as { error?: string }).error ?? "" };
}

const artifactsOf = (threadId: string) => packets.get(threadId)!.artifacts.map((artifact) => artifact.ref);

describe("file scope follows the turn the token belongs to", () => {
  it("a read-only turn's token can't record an outside file on another chat's task", async () => {
    const result = await post("taskState", ["bot-a", "chat-a"], { fromBotId: "bot-b", fromThreadId: "chat-b", artifacts: [{ ref: outside, label: "x" }] });
    expect(result.status).toBe(403);
    expect(artifactsOf("chat-b")).toEqual([]);
  });

  it("a read-only turn's token can't show an outside picture in another chat", async () => {
    const result = await post("showImage", ["bot-a", "chat-a"], { fromBotId: "bot-b", fromThreadId: "chat-b", path: outside });
    expect(result.status).toBe(403);
    expect(result.error).toContain("does not belong to sender");
  });

  it("the chat's own working turn still records any local file", async () => {
    const result = await post("taskState", ["bot-b", "chat-b"], { fromBotId: "bot-b", fromThreadId: "chat-b", artifacts: [{ ref: outside, label: "x" }] });
    expect(result.status).toBe(200);
    expect(artifactsOf("chat-b")).toEqual([realpathSync(outside)]);
  });

  it("the boot token can still write for a named chat", async () => {
    const result = await post("taskState", null, { fromBotId: "bot-b", fromThreadId: "chat-b", artifacts: [{ ref: outside, label: "x" }] });
    expect(result.status).toBe(200);
  });
});
