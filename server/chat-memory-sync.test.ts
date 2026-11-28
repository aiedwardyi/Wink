import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import type { Message } from "./store.ts";
import { loadThreadSyncLedger, pullThread, saveThreadSyncLedger, uploadThread, type LocalThread, type ThreadSyncHost } from "./thread-sync.ts";
import { ThreadSyncV2 } from "./thread-sync-v2.ts";
import { completedTool, recordedArtifactsPatch } from "./tool-activity.ts";
import { chatMemory } from "./turn-context.ts";
import { removeTestData, testHome } from "./testing/test-home.ts";

const roots: string[] = [];
const clients: ThreadSyncV2[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const root of roots.splice(0)) removeTestData(root);
});

function temp(): string {
  const root = mkdtempSync(join(testHome(), "chat-memory-sync-"));
  roots.push(root);
  return root;
}

const launch = join(tmpdir(), "launch outside task");
const plan = join(launch, "paste", "03-thursday.md");
const shots = Array.from({ length: 11 }, (_, index) => join(launch, "real-shots", `workers-${String(index + 1).padStart(2, "0")}.png`));
const recorded = [{ ref: plan, label: "Thursday launch plan" }, ...shots.map((ref, index) => ({ ref, label: `Worker shot ${index + 1}` }))];

/** PC A's thread after the bot recorded the plan and shots with update_task_state, during its call or after the turn ended. */
function recordedThread(late = false): Message[] {
  const asked: Message = { id: "u1", role: "user", kind: "text", text: "post thursday", at: 1, parentId: null };
  const call: Message = { id: "t1", role: "bot", kind: "activity", at: 2, parentId: "u1", tool: { name: "mcp__agents__update_task_state" } };
  if (late) call.tool!.ok = true;
  const reply: Message = { id: "b1", role: "bot", kind: "text", text: "Posted.", at: 3, parentId: "t1" };
  const rows = late ? [asked, call, reply] : [asked, call];
  const patch = recordedArtifactsPatch(rows, recorded);
  expect(patch?.id).toBe(late ? "b1" : "t1");
  return rows.map((row) => row.id === patch!.id ? { ...row, recorded: patch!.recorded } : row);
}

const memoryOnB = (messages: readonly Message[]) => chatMemory({ record: null, messages });

it("keeps recorded files when the call's row completes", () => {
  const [, row] = recordedThread();
  // SAFETY: completedTool reads only the event's ok, summary, durationMs, detail, writes and made.
  const tool = completedTool(row!.tool, { type: "item.completed", itemType: "tool", ok: true } as Parameters<typeof completedTool>[1]);
  expect({ ...row, tool }.recorded).toEqual(recorded);
  expect(recordedArtifactsPatch([], recorded)).toBeNull();
});

it("carries recorded files to the other PC on V1 sync", () => {
  const folder = temp();
  const host = (deviceId: string, threads: Map<string, LocalThread>): ThreadSyncHost => {
    const dataDir = temp();
    const self: ThreadSyncHost = {
      folder, dataDir, deviceId,
      ledger: loadThreadSyncLedger(dataDir),
      saveLedger: () => saveThreadSyncLedger(dataDir, self.ledger),
      local: (threadId) => threads.get(threadId) ?? null,
      running: () => false,
      adopt: (_botId, file) => void threads.set(file.task.threadId, { title: file.task.title, createdAt: file.task.createdAt, messages: structuredClone(file.messages), activeLeafId: file.activeLeafId }),
      remove: () => {},
      conflicted: () => {},
      now: () => 1_700_000_000_500,
    };
    return self;
  };
  const onA = new Map<string, LocalThread>([["t1", { title: "Marketing", createdAt: 1, messages: recordedThread(true), activeLeafId: "b1" }]]);
  const onB = new Map<string, LocalThread>();
  expect(uploadThread(host("pc-a", onA), "marketing", "t1")).toBe("written");
  expect(pullThread(host("pc-b", onB), "bot", "marketing", "t1")).toBe("imported");
  const text = memoryOnB(onB.get("t1")!.messages);
  expect(text).toContain(`Read first, your plan: ${plan}`);
  expect(text).toContain(`${join(launch, "real-shots")} 11 (workers-11.png, workers-10.png)`);
});

it.each([false, true])("carries recorded files to the other PC on V2 sync, late call %s", async (late) => {
  const folder = temp();
  const scope = { botSyncId: "marketing", threadId: "t1" };
  const a = new ThreadSyncV2({ folder, dataDir: temp(), deviceId: "pc-a" });
  const b = new ThreadSyncV2({ folder, dataDir: temp(), deviceId: "pc-b" });
  clients.push(a, b);
  const rows = recordedThread(late);
  await a.commit(scope, [...rows.map((value) => ({ kind: "row" as const, value })), { kind: "metadata", value: { title: "Marketing", createdAt: 1 } }, { kind: "head", value: rows.at(-1)!.id }]);
  await a.flush(scope);
  await b.pull(scope);
  const text = memoryOnB((await b.scan(scope.threadId)).messages);
  expect(text).toContain(`Read first, your plan: ${plan}`);
  expect(text).toContain(`${join(launch, "real-shots")} 11 (workers-11.png, workers-10.png)`);
});

it("scrubs a credential from a recorded label before it reaches the other PC", async () => {
  const folder = temp();
  const scope = { botSyncId: "marketing", threadId: "t1" };
  const a = new ThreadSyncV2({ folder, dataDir: temp(), deviceId: "pc-a" });
  const b = new ThreadSyncV2({ folder, dataDir: temp(), deviceId: "pc-b" });
  clients.push(a, b);
  const marker = "ghp_" + "J7k9U3v8N5w2Z6t4X1r0M9s8K7j6H5g4F3d2";
  const row: Message = { id: "b1", role: "bot", kind: "text", text: "Saved the plan.", at: 1, parentId: null, recorded: [{ ref: plan, label: `Plan ${marker}` }] };
  await a.commit(scope, [{ kind: "row", value: row }, { kind: "metadata", value: { title: "Marketing", createdAt: 1 } }, { kind: "head", value: "b1" }]);
  await a.flush(scope);
  await b.pull(scope);
  const [local, peer] = await Promise.all([a.scan(scope.threadId), b.scan(scope.threadId)]);
  for (const { messages } of [local, peer]) {
    expect(messages.flatMap((message) => message.recorded ?? []).map((item) => item.ref)).toEqual([plan]);
    expect(JSON.stringify(messages)).not.toContain(marker);
  }
});
