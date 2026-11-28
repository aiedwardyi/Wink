import type { RuntimeEvent } from "./contracts.ts";
import type { Message } from "./store.ts";

/** The row a task-state call's files ride to other PCs: its open update_task_state row, else the newest row, since a call can land with none open. */
export function recordedArtifactsPatch(
  messages: readonly Message[],
  artifacts: NonNullable<Message["recorded"]>,
): { id: string; recorded: NonNullable<Message["recorded"]> } | null {
  const row = messages.findLast((message) =>
    message.kind === "activity" && message.tool?.name.includes("update_task_state") === true && message.tool.ok === undefined) ?? messages.at(-1);
  return row ? { id: row.id, recorded: [...row.recorded ?? [], ...artifacts] } : null;
}

export function completedTool(
  existing: Message["tool"],
  event: Extract<RuntimeEvent, { type: "item.completed"; itemType: "tool" }>,
): NonNullable<Message["tool"]> {
  const summary = event.summary ?? existing?.summary;
  const tool: NonNullable<Message["tool"]> = {
    name: existing?.name ?? "tool",
    ok: event.ok,
    spoken: existing?.spoken,
    ...(summary ? { summary } : {}),
    ...(typeof event.durationMs === "number" ? { durationMs: event.durationMs } : {}),
    ...(event.detail ? { detail: event.detail } : {}),
    ...(event.ok && event.writes?.length ? { writes: event.writes } : {}),
  };
  if (existing?.verb) tool.verb = existing.verb;
  return tool;
}
