import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { createBotChatRoutes } from "./bot-chat-routes.ts";
import { createGroupRoutes } from "./group-routes.ts";
import { redactBotAuthored, type Message } from "./store.ts";
import { createThreadRoutes } from "./thread-routes.ts";

const secret = `sk-ant-${"a1B2".repeat(8)}`;
const raw = (): Message => ({
  id: "m1", at: 1, role: "bot", kind: "options", text: `key ${secret}`, reactions: [{ emoji: "+", by: "user" }],
  card: { title: "Pick", requestId: "r1", askUser: true },
} as unknown as Message);
const clientMessage = (message: Message) => redactBotAuthored(message);

const servers: ReturnType<typeof createServer>[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.close(); });

async function call(route: (req: IncomingMessage, res: ServerResponse) => unknown, body: unknown) {
  const server = createServer((req, res) => { void route(req, res); });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: JSON.stringify(body) });
  return { status: response.status, text: await response.text() };
}

const match = ["", "t1", "m1"] as unknown as RegExpMatchArray;
const stored = raw();
const store = {
  bot: () => ({ id: "b1", threadId: "t1" }),
  group: () => ({ id: "g1", threadId: "t1" }),
  messagesFor: () => [stored],
  toggleReaction: () => stored,
  patchMessage: () => stored,
};

describe("write routes mask the message they return", () => {
  it.each([
    ["reaction", () => createThreadRoutes({ dataDir: DATA_DIR, store, clientMessage } as never).reaction, { emoji: "+" }],
    ["bot card", () => createBotChatRoutes({ store, clientMessage } as never).patchCard, { answered: "x" }],
    ["group card", () => createGroupRoutes({ store, clientMessage } as never).patchCard, { answered: "x" }],
  ])("%s", async (_name, pick, body) => {
    const handler = pick() as (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray) => unknown;
    const { status, text } = await call((req, res) => handler(req, res, match), body);
    expect(status).toBe(200);
    expect(text).not.toContain(secret);
    expect(JSON.parse(text).message.text).toBe("key «redacted 39 chars»");
    expect(stored.text).toBe(`key ${secret}`);
  });
});
