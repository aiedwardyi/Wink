import { findDelegationReceipt } from "./delegation-ledger.ts";
import { terminalMailState, type MailState } from "./mail-types.ts";
import { redactSecretsInText } from "./redact.ts";
import type { Message } from "./store.ts";

export const delegationGist = (text = "") => redactSecretsInText(text).split(/\r\n?|\n/)[0]!.slice(0, 100);

function taskContext(id: string, peer?: string, reply?: Message, state?: MailState): string {
  const receipt = findDelegationReceipt(id);
  peer ??= receipt?.toBotName ?? reply?.comm?.withName;
  state = receipt?.state ?? state ?? reply?.comm?.state;
  const gist = state && terminalMailState(state) ? delegationGist(reply?.text ?? receipt?.result) : "";
  return `task ${id.slice(0, 8)}${peer ? ` -> @${peer}` : ""}${gist ? `: ${JSON.stringify(gist)}` : ""}`;
}

export function delegationContext(messages: Message[], referenceMessages: Message[]): Map<string, string> {
  const details = new Map<string, string>();
  const calls = new Map<string, Message[]>();
  const replies = new Map(referenceMessages.filter((row) => row.comm?.taskId && row.comm.peer === "reply").map((row) => [row.comm!.taskId!, row]));
  const seen = new Set<string>();
  for (const row of messages) {
    const speaker = row.from?.botId ?? "Bot";
    if (row.kind === "text" && row.role === "user") calls.clear();
    else if (row.kind === "text") calls.delete(speaker);
    const name = row.tool?.name.replace(/^mcp__.+?__/, "");
    if (name === "delegate_bot" || name === "ask_bot") {
      const id = /Task id:\s*([\w-]{8,64})/.exec(row.tool?.detail?.output?.join("\n") ?? "")?.[1];
      if (id) {
        const receipt = findDelegationReceipt(id);
        details.set(row.id, taskContext(id, receipt?.toBotName, replies.get(id)));
        seen.add(id);
        continue;
      }
      const pending = calls.get(speaker) ?? [];
      pending.push(row);
      calls.set(speaker, pending);
    }
    const id = row.comm?.taskId;
    if (!id && row.comm?.peer === "message") {
      const pending = calls.get(speaker) ?? [];
      const index = pending.findIndex((call) => call.tool!.name.replace(/^mcp__.+?__/, "") === "ask_bot");
      if (index >= 0) pending.splice(index, 1);
    }
    if (!id || row.comm?.peer === "reply" || row.comm?.peer === "from" || seen.has(id)) continue;
    seen.add(id);
    const receipt = findDelegationReceipt(id);
    const pending = calls.get(speaker) ?? [];
    const kind = receipt?.kind === "ask" ? "ask_bot" : receipt?.kind === "delegation" ? "delegate_bot" : undefined;
    const index = pending.findIndex((call) => !kind || call.tool!.name.replace(/^mcp__.+?__/, "") === kind);
    if (index < 0 && row.comm?.peer !== "message" && receipt?.kind !== "ask") continue;
    const call = index < 0 ? row : pending.splice(index, 1)[0]!;
    details.set(call.id, taskContext(id, row.comm!.withName, replies.get(id), row.comm?.state));
  }
  return details;
}

export function delegationRollup(run: ReadonlyArray<{ chip?: { name: string; delegation?: string } }>, name: string): string {
  return run.filter((unit) => unit.chip?.delegation)
    .filter((unit) => unit.chip!.name.replace(/^mcp__.+?__/, "") === name).slice(-5)
    .map((unit) => ` (${unit.chip!.delegation})`).join("");
}
