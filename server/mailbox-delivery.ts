import type { IncomingMessage } from "node:http";
import { mailboxNoteText, mailboxPostSchema, mailboxRecipient, mailboxScope, readMailboxBody } from "./mailbox.ts";
import type { createMailboxReceipts } from "./mailbox-receipts.ts";
import type { BotRecord, Message, Store } from "./store.ts";
import type { MailboxIdentity } from "./mailbox.ts";
import type { createVerifyWorkers } from "./verify-workers.ts";

type Scope = { pane: string; bot: string; teacher: string };
type Kind = "report" | "auto" | "stall" | undefined;
type Dependencies = {
  secret: string;
  store: Pick<Store, "bots" | "appendMessage">;
  receipts: ReturnType<typeof createMailboxReceipts>;
  origin: string;
  label: (scope: Scope) => Promise<string | null>;
  auto: (scope: Scope, text: string, identity?: MailboxIdentity) => Promise<boolean>;
  attention: (scope: Scope, kind: Kind, text?: string) => Promise<void>;
  reported: (scope: Scope, text: string, source: BotRecord) => void;
  refresh: (text: string) => void;
  notify: (source: BotRecord, text: string) => void;
  arrived: (scope: Scope, source: BotRecord) => void;
  /** Live Verify on a worker's DONE: a held note wakes the bot once its check ends. */
  check?: Pick<ReturnType<typeof createVerifyWorkers>, "plan" | "held">;
};

export async function receiveMailboxPost(req: IncomingMessage, deps: Dependencies) {
  const scope = mailboxScope(req.headers, deps.secret);
  if (!scope.ok) return { status: 401, body: { error: scope.error } };
  const body = await readMailboxBody(req);
  if (!body.ok) return { status: body.status, body: { error: body.error } };
  const parsed = mailboxPostSchema.safeParse(body.value);
  if (!parsed.success) return { status: 400, body: { error: "invalid mailbox message" } };
  const recipient = mailboxRecipient(deps.store.bots, scope);
  if (!recipient) return { status: 404, body: { error: "no such bot" } };
  const source = { ...recipient };
  const input = parsed.data;
  let kind = input.kind;
  let accepted = false;
  let held: { plan: Parameters<NonNullable<Dependencies["check"]>["held"]>[0]; message: Message } | undefined;
  const result = await deps.receipts.accept(scope, input.messageId, async key => {
    deps.refresh(input.text);
    if (kind === "auto") {
      const identity = input.messageId ? { messageId: input.messageId, sentAt: input.sentAt, queued: input.queued } : undefined;
      if (await deps.auto(scope, input.text, identity)) return { ok: true, deferred: true };
      kind = undefined;
    }
    const label = await deps.label(scope);
    let note = mailboxNoteText(scope.pane, source.name || source.id, source.id, input.text, label);
    if (!note) throw Object.assign(new Error("empty message"), { status: 400 });
    if (input.queued && input.sentAt !== undefined) {
      const sent = new Date(input.sentAt);
      const time = `${String(sent.getHours()).padStart(2, "0")}:${String(sent.getMinutes()).padStart(2, "0")}`;
      note += `\n(sent ${time} while Wink was closed)`;
    }
    const row: Omit<Message, "id" | "at"> = { role: "bot", kind: "note", text: note, origin: deps.origin };
    if (key) row.mailbox = { key };
    const check = await deps.check?.plan(scope, input.text, kind, source);
    if (check && "verifyNote" in check) row.verifyNote = check.verifyNote;
    if (check && "hold" in check) row.hold = check.hold;
    const message = deps.store.appendMessage(source.threadId, row);
    if (check && "plan" in check) held = { plan: check.plan, message };
    accepted = true;
    return { ok: true, id: message.id };
  }, input.kind !== "auto").catch(error => {
    if (error.status === 400) return { error: "empty message" };
    throw error;
  });
  if ("error" in result) return { status: 400, body: result };
  if (accepted) {
    if (kind === "report") { await deps.attention(scope, kind, input.text); deps.reported(scope, input.text, source); }
    if (source.notifications !== false) deps.notify(source, input.text);
    if (kind !== "report") void deps.attention(scope, kind);
    if (held) deps.check!.held(held.plan, held.message);
    else deps.arrived(scope, source);
  }
  return { status: 200, body: result };
}
