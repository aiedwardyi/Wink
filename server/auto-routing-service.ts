import { createHash } from "node:crypto";

import type { AutoTask } from "../shared/auto-routing.ts";
import { writeFileAtomic } from "./atomic.ts";
import { AutoRoutingHabits } from "./auto-routing-habits.ts";
import { createAutoJournal } from "./auto-routing-journal.ts";
import { createAutoRoutingOperations } from "./auto-routing-operations.ts";
import { AutoRoutingRules } from "./auto-routing-rules.ts";
import { AutoRoutingState } from "./auto-routing.ts";
import type { Message, Store } from "./store.ts";
import { turnRegistry } from "./turn-registry.ts";

export function createAutoRoutingService(dataDir: string, store: Store, write = writeFileAtomic) {
  const journal = createAutoJournal(dataDir, write);
  const state = new AutoRoutingState(dataDir, journal.write);
  const rules = new AutoRoutingRules(dataDir, journal.write);
  const habits = new AutoRoutingHabits(dataDir, journal.write);
  journal.reloads(state, rules, habits);
  const direct = new Map<string, Map<string, string>>();
  const fingerprint = (line: Message) => createHash("sha256").update(JSON.stringify([line.id, line.text])).digest("hex");
  store.onChange((change) => {
    if (change.type === "thread.deleted") direct.delete(change.threadId);
    if (change.type !== "message" || change.imported) return;
    const line = change.message;
    if (line.role !== "user" || line.kind !== "text" || line.from || line.comm || line.origin) return;
    const lines = direct.get(change.threadId) ?? new Map<string, string>();
    lines.set(line.sendId ?? line.id, fingerprint(line));
    direct.set(change.threadId, lines);
  });
  const source = (botId: string, threadId: string) => ({ botId, threadId, ownerId: "user", authorized: Boolean(store.conversationForBot(botId, threadId)),
    turn: turnRegistry.current(threadId), messages: store.activePath(threadId).map((line) => ({ ...line,
      imported: direct.get(threadId)?.get(line.sendId ?? line.id) !== fingerprint(line) })) });
  const taskId = (botId: string, threadId: string) => store.taskByThread(botId, threadId)?.threadId;
  const operations = createAutoRoutingOperations({ state, rules, habits, source, taskId, transaction: journal.transaction,
    emit: (_botId, threadId, row) => {
      for (const message of store.messagesFor(threadId)) {
        if (message.autoChange?.undoable) store.patchMessage(threadId, message.id, { autoChange: { ...message.autoChange, undoable: false } });
      }
      store.appendMessage(threadId, { role: "bot", kind: "activity", autoChange: row });
    },
  });
  const habit = (taskClass: AutoTask, now: number) => habits.preference("worker", taskClass, now);
  return { state, rules, habits, source, taskId, transaction: journal.transaction, write: journal.write, register: journal.reloads, habit, ...operations };
}
