import type { CommsBus } from "./comms-visibility.ts";
import { asksSender } from "./delegate-askback.ts";
import type { DelegationReceipt } from "./delegations.ts";
import type { MailDestination } from "./mail-types.ts";
import { registerReplyWake } from "./mail.ts";

export function replyDestinations(bus: CommsBus, receipt: DelegationReceipt, statusOnly = false): MailDestination[] {
  const sender = receipt.source && bus.store.bot(receipt.source.botId);
  const target = bus.store.bot(receipt.toBotId);
  const sourceId = receipt.sourceThreadId;
  const channel = receipt.source && bus.store.dmGroup(receipt.source.botId, receipt.toBotId);
  const sourceRoom = bus.store.groupByThread(sourceId);
  if (!sender && !sourceRoom && !channel) return [];
  const homeId = sender ? bus.store.taskByThread(sender.id, sourceId) || sourceRoom ? sourceId : sender.threadId : sourceRoom?.threadId ?? channel!.threadId;
  const room = bus.store.groupByThread(homeId);
  const success = receipt.status === "done";
  const reply = receipt.result ?? "";
  const hasReply = success && !statusOnly && !!reply.trim();
  const comm = {
    groupId: channel?.id ?? room?.id ?? sender?.id ?? "",
    withBotId: receipt.toBotId,
    withName: receipt.toBotName,
    withColor: target?.color ?? sender?.color ?? "",
    taskId: receipt.id,
    deliver: receipt.deliver ?? "queued" as const,
    state: receipt.state,
  };
  const row: NonNullable<MailDestination["row"]> = hasReply
    ? {
        role: "bot", kind: room ? "text" : "activity", text: reply,
        ...(room ? { from: { botId: receipt.toBotId, name: receipt.toBotName, color: comm.withColor } } : { tool: { name: `Reply from @${receipt.toBotName}` } }),
        comm: { ...comm, peer: "reply", ...(receipt.kind === "delegation" && !room && sender && asksSender(reply, sender.name) ? { wake: true as const } : {}) },
      }
    : { role: "bot", kind: "activity", tool: { name: reply || "Delegated turn completed", ok: success }, ...(room && sender ? { from: { botId: sender.id, name: sender.name, color: sender.color } } : {}), comm };
  if (row.comm?.wake) row.origin = bus.deviceId;
  const destinations: MailDestination[] = [];
  const add = (threadId: string, role: string, value: NonNullable<MailDestination["row"]>) => {
    const mailKey = `${receipt.id}:${role}:${threadId}`;
    destinations.push({ threadId, mailKey, row: { ...value, comm: { ...value.comm!, mailKey } } });
  };
  add(homeId, hasReply ? "reply" : "status", row);
  if (channel && channel.threadId !== homeId) {
    add(channel.threadId, "reply", { ...row, kind: hasReply ? "text" : "activity", from: { botId: receipt.toBotId, name: receipt.toBotName, color: comm.withColor }, tool: hasReply ? undefined : row.tool, comm: { ...comm, peer: hasReply ? "reply" : undefined } });
  }
  if (room && sender && homeId !== sender.threadId) {
    add(sender.threadId, "chip", { role: "bot", kind: "activity", tool: { name: `@${receipt.toBotName} finished task ${receipt.id} in ${room.name}`, ok: success }, comm: { ...comm, groupId: room.id } });
  }
  return destinations;
}

export function publishPeerReply(bus: CommsBus, receipt: DelegationReceipt, repair = false): void {
  for (const destination of receipt.publish ?? []) {
    if (!destination.row) continue;
    if (!bus.store.botByThread(destination.threadId) && !bus.store.groupByThread(destination.threadId)) continue;
    const existing = bus.store.messagesFor(destination.threadId).find((row) => row.comm?.mailKey === destination.mailKey);
    const row = existing && destination.row.comm?.peer !== "reply"
      ? bus.store.patchMessage(destination.threadId, existing.id, destination.row)!
      : bus.store.appendMessage(destination.threadId, destination.row);
    if (repair && row.comm?.wake) bus.store.patchMessage(destination.threadId, row.id, { comm: { ...row.comm, wake: undefined }, origin: undefined });
    destination.rowId = row.id;
    const room = bus.store.groupByThread(destination.threadId);
    if (room) bus.store.patchGroup(room.id, { unread: true });
  }
}

export function wakeForPeerReply(bus: CommsBus, receipt: DelegationReceipt): void {
  if (!bus.wakeSender || receipt.status !== "done" || !receipt.result?.trim()) return;
  const sender = receipt.source && bus.store.bot(receipt.source.botId);
  if (!sender) return;
  const question = asksSender(receipt.result, sender.name);
  if (!question && (sender.busy || bus.senderBusy?.(sender.id, receipt.sourceThreadId))) return;
  const home = receipt.publish?.find((destination) => destination.threadId === receipt.sourceThreadId && destination.row?.comm?.peer === "reply");
  if (!home || !bus.store.taskByThread(sender.id, home.threadId) || bus.store.groupByThread(home.threadId)) return;
  const row = bus.store.messagesFor(home.threadId).find((row) => row.comm?.mailKey === home.mailKey);
  if (!row && home.row?.comm?.wake) bus.replyUnwoken?.(sender.id, "reply post failed");
  if (!row || row.comm?.read) return;
  registerReplyWake(row);
  bus.wakeSender(sender.id, home.threadId);
}
