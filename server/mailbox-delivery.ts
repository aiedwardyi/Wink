import type { IncomingMessage } from "node:http";
import { mailboxNoteText, mailboxPostSchema, mailboxRecipient, mailboxScope, readMailboxBody } from "./mailbox.ts";
import type { createMailboxReceipts } from "./mailbox-receipts.ts";
import type { BotRecord, Message, Store } from "./store.ts";

type Scope = { pane: string; bot: string; teacher: string };
type Kind = "report" | "auto" | "stall" | undefined;
type Dependencies = {
  secret: string;
  store: Pick<Store, "bots" | "appendMessage">;
  receipts: ReturnType<typeof createMailboxReceipts>;
  origin: string;
  label: (scope: Scope) => Promise<string | null>;
  auto: (scope: Scope, text: string) => Promise<boolean>;
  attention: (scope: Scope, kind: Kind) => Promise<void>;
  reported: (scope: Scope, text: string) => void;
  refresh: (text: string) => void;
  notify: (source: BotRecord, text: string) => void;
  arrived: (scope: Scope, source: BotRecord) => void;
};

export async function receiveMailboxPost(req: IncomingMessage, deps: Dependencies) {
  const scope = mailboxScope(req.headers, deps.secret);
  if (!scope.ok) return { status: 401, body: { error: scope.error } };
  const body = await readMailboxBody(req);
  if (!body.ok) return { status: body.status, body: { error: body.error } };
  const parsed = mailboxPostSchema.safeParse(body.value);
  if (!parsed.success) return { status: 400, body: { error: "invalid mailbox message" } };
  const source = mailboxRecipient(deps.store.bots, scope);
  if (!source) return { status: 404, body: { error: "no such bot" } };
  const input = parsed.data;
  let kind = input.kind;
  let accepted = false;
  const result = await deps.receipts.accept(scope, input.messageId, async key => {
    deps.refresh(input.text);
    if (kind === "auto") {
      if (await deps.auto(scope, input.text)) return { ok: true, deferred: true };
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
    const message = deps.store.appendMessage(source.threadId, row);
    accepted = true;
    return { ok: true, id: message.id };
  }).catch(error => {
    if (error.status === 400) return { error: "empty message" };
    throw error;
  });
  if ("error" in result) return { status: 400, body: result };
  if (accepted) {
    if (kind === "report") { await deps.attention(scope, kind); deps.reported(scope, input.text); }
    if (source.notifications !== false) deps.notify(source, input.text);
    if (kind !== "report") void deps.attention(scope, kind);
    deps.arrived(scope, source);
  }
  return { status: 200, body: result };
}
