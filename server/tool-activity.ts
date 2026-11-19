import type { RuntimeEvent } from "./contracts.ts";
import type { Message } from "./store.ts";

/** The open update_task_state row a task-state call belongs to, with the files it recorded added. */
export function recordedArtifactsPatch(
  messages: readonly Message[],
  artifacts: NonNullable<NonNullable<Message["tool"]>["artifacts"]>,
): { id: string; tool: NonNullable<Message["tool"]> } | null {
  const row = messages.findLast((message) =>
    message.kind === "activity" && message.tool?.name.includes("update_task_state") === true && message.tool.ok === undefined);
  return row?.tool ? { id: row.id, tool: { ...row.tool, artifacts: [...row.tool.artifacts ?? [], ...artifacts] } } : null;
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
  if (existing?.artifacts) tool.artifacts = existing.artifacts;
  return tool;
}
