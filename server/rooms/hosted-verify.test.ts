import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { RuntimeEvent } from "../contracts.ts";
import { Store, type GroupRecord } from "../store.ts";
import { createVerifyAuto } from "../verify-auto.ts";
import { closeRoomsDb, createRoom } from "./db.ts";
import { isHostedThread } from "./guards.ts";

let store: Store;
let hosted: GroupRecord;
let plain: GroupRecord;
let root: string;
let server: Server;
let hits: number;
const spyDeps = () => ({
  startAuto: vi.fn(async (_input: unknown) => {}),
  startDocs: vi.fn((_input: unknown) => {}),
  docTurnEnded: vi.fn((_input: unknown) => {}),
  cancelQueued: vi.fn((_threadId: string) => {}),
  scan: vi.fn(async (_root: string, _since: number) => [] as string[]),
});
let spies: ReturnType<typeof spyDeps>;

beforeEach(async () => {
  closeRoomsDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  store = new Store(() => ({ instanceId: "fake", model: "m" }));
  const bot = store.createBot();
  hosted = store.createGroup("Team", [bot.id], false, undefined, undefined, { roomId: createRoom("Team").id });
  plain = store.createGroup("Plain", [bot.id]);
  root = realpathSync(mkdtempSync(join(tmpdir(), "wink-hosted-verify-")));
  writeFileSync(join(root, "index.html"), "<h1>Hi</h1>");
  writeFileSync(join(root, "report.md"), "# Report\n\nA real document with enough words in it to be checked by Live Verify.\n");
  hits = 0;
  server = createServer((_req, res) => {
    hits++;
    res.writeHead(200, { "content-type": "text/html" }).end("<h1>Hi</h1>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  spies = spyDeps();
});
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
  closeRoomsDb();
});

/** A work turn that wrote a page and a doc, and named a localhost URL. */
async function workTurn(threadId: string, reply: string) {
  const auto = createVerifyAuto({ enabled: () => true, skip: (id) => isHostedThread(store, id), freeMemory: () => 8 * 1024 ** 3, log: vi.fn(), app: { waitMs: 300 }, ...spies });
  const event = (fields: Partial<RuntimeEvent>) => ({ eventId: "e", provider: "claudeAgent", threadId, turnId: "turn", createdAt: new Date().toISOString(), ...fields }) as RuntimeEvent;
  auto.event(event({ type: "item.started", itemType: "tool", itemId: "w", title: "Write" }));
  auto.event(event({ type: "item.completed", itemType: "tool", itemId: "w", ok: true, writes: [join(root, "index.html"), join(root, "report.md")] }));
  await auto.settled({ botId: "bot", threadId, turnId: "turn", startedAt: Date.now() - 1_000, roots: [root], depth: 0, ok: true, humanId: "h", humanText: "Build the page and write report.md", reply });
}

describe("Live Verify in a team room", () => {
  it("makes 0 Live Verify, doc-fix or loopback calls after a hosted work turn", async () => {
    const port = (server.address() as AddressInfo).port;
    await workTurn(hosted.threadId, `Done: http://localhost:${port}/ and report.md`);
    expect(hits).toBe(0);
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
  });

  it("still checks the same turn in an ordinary room", async () => {
    const port = (server.address() as AddressInfo).port;
    await workTurn(plain.threadId, `Done: http://localhost:${port}/`);
    expect(hits).toBeGreaterThan(0);
    expect(spies.startAuto).toHaveBeenCalledTimes(1);
  });

  it("is wired to skip hosted threads in the server", () => {
    const source = readFileSync(join(import.meta.dirname, "..", "index.ts"), "utf8");
    const file = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
    const walk = (node: ts.Node): ts.CallExpression | undefined =>
      ts.isCallExpression(node) && node.expression.getText(file) === "createVerifyAuto" ? node : ts.forEachChild(node, walk);
    const call = walk(file)!;
    const skip = (call.arguments[0] as ts.ObjectLiteralExpression).properties.find((property) => property.name?.getText(file) === "skip");
    expect(skip?.getText(file)).toBe("skip: threadId => isHostedThread(store, threadId)");
  });
});
