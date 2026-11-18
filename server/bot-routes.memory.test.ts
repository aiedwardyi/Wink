import { copyFileSync, mkdirSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { createBotRoutes } from "./bot-routes.ts";
import { DATA_DIR } from "./config.ts";
import { createMemoryHealthCheck } from "./memory-health.ts";
import { markTalked, memorySyncDir, syncBotMemory, type MemorySyncLedger } from "./memory-sync.ts";
import { Store } from "./store.ts";
import { memoryHealth, readMemoryFile, workspaceDir, writeMemoryFile } from "./workspace.ts";

it("keeps a hand save made after the peer chatted before its snapshot arrived", async () => {
  const botId = "bot-a";
  const syncId = "shared-bot";
  const folder = join(DATA_DIR, "drive");
  const peerFolder = join(DATA_DIR, "peer-drive");
  const peerId = "bot-b";
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture", mode: "automatic" }));
  store.createBot({ name: "Ada" }, { id: botId, seedMessages: false });
  const local: MemorySyncLedger = { bots: {} };
  const peer: MemorySyncLedger = { bots: {} };
  const sync = () => syncBotMemory(folder, syncId, workspaceDir(botId), local, { host: "local" });
  const syncPeer = () => syncBotMemory(peerFolder, syncId, workspaceDir(peerId), peer, { host: "peer" });
  const deliver = (from: string, to: string, device: string) => {
    const name = `${device}.json`;
    mkdirSync(memorySyncDir(to, syncId), { recursive: true });
    copyFileSync(join(memorySyncDir(from, syncId), name), join(memorySyncDir(to, syncId), name));
  };
  mkdirSync(folder);
  mkdirSync(peerFolder);
  writeMemoryFile(botId, "- Shared notes\n");
  sync();
  deliver(folder, peerFolder, local.device!);
  syncPeer();

  const now = Date.now();
  markTalked(peer, syncId, now - 1000);
  writeMemoryFile(peerId, "- Peer chat notes\n");
  syncPeer();

  const noteTalked = (id: string) => { if (id === botId) markTalked(local, syncId, now); };
  const deps: Partial<Parameters<typeof createBotRoutes>[0]> = {
    store,
    memoryHealthCheck: createMemoryHealthCheck({ health: memoryHealth, dropped: () => undefined }),
  };
  // SAFETY: putMemory uses only the store, health check and activity callback.
  const routes = createBotRoutes(Object.assign(deps, { noteTalked }) as Parameters<typeof createBotRoutes>[0]);
  const text = "- My hand edit\n";
  const req = new IncomingMessage(new Socket());
  req.push(Buffer.from(JSON.stringify({ text, baseRevision: readMemoryFile(botId).revision })));
  req.push(null);
  const res = new ServerResponse(req);
  const writeHead = vi.spyOn(res, "writeHead");
  await routes.putMemory(req, res, ["", botId]);
  expect(writeHead).toHaveBeenCalledWith(200, expect.anything());
  deliver(peerFolder, folder, peer.device!);
  expect(sync()["MEMORY.md"]).toBe("conflict");
  expect(readMemoryFile(botId).text).toBe(text);
});
