import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeDrive } from "./testing/fake-drive.ts";
import type { Message } from "./store.ts";
import type { SyncHead, SyncVersion, ThreadSyncV2 } from "./thread-sync-v2.ts";
import { testBootReads } from "./testing/boot-rows.ts";
import { removeTestData, testHome } from "./testing/test-home.ts";

let root: string;
let close = async () => {};
let releaseDownload = () => {};

beforeEach(() => {
  root = mkdtempSync(join(testHome(), "sync-hold-"));
  vi.stubEnv("OMB_DATA_DIR", join(root, "data"));
});

afterEach(async () => {
  releaseDownload();
  await close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  removeTestData(root);
});

async function boot(google = false) {
  await close();
  vi.resetModules();
  const { Store } = await import("./store.ts");
  const queue = await import("./steer-queue.ts");
  const { createThreadSyncV2Store } = await import("./thread-sync-v2-store.ts");
  const { createBotChatRoutes } = await import("./bot-chat-routes.ts");
  const { SendSequencer } = await import("./send-idempotency.ts");
  const { startedTurn } = await import("./send-receipt.ts");
  const { closeMessageDb, messageDatabase } = await import("./message-db.ts");
  const dataDir = join(root, "data");
  const folder = google ? join(dataDir, "google-drive") : join(root, "folder");
  mkdirSync(folder, { recursive: true });
  const store = new Store(() => ({ instanceId: "fake", model: "fake" }));
  const fresh = store.bots.length === 0;
  const bot = store.bots[0] ?? store.createBot({}, { seedMessages: false });
  if (fresh) store.adoptSyncedTask(bot.id, { threadId: "thread", title: "Chat", createdAt: 1 }, [], null, true);
  let enabled = true;
  const sync = createThreadSyncV2Store({
    store, dataDir, deviceId: "local", bootReads: testBootReads(dataDir), folder: () => enabled ? folder : null, enabled: () => enabled,
    target: (threadId) => threadId === "thread" ? { botId: bot.id, botSyncId: "bot" } : null,
    bots: () => [{ botId: bot.id, botSyncId: "bot" }], running: () => Boolean(store.bot(bot.id)?.busy),
    project: (message) => message, imported: () => {}, maintenance: () => {},
  })!;
  if (fresh) store.appendMessage("thread", { role: "user", kind: "text", text: "local" });
  const local = store.activeLeaf("thread")!;
  const contexts: Message[][] = [];
  const run = vi.fn((_bot: string, threadId: string, _prompt: string, _message: Message | null) => {
    store.patchBot(bot.id, { busy: true });
    contexts.push(store.activePath(threadId));
  });
  const drain = () => queue.drainSteeredMessages(store, run);
  queue.initializeSteerQueue(store, drain);
  const startTurn = vi.fn(async (_bot: string, text: string, options: { sendId?: string; replyTo?: Message }) => {
    const message = store.appendMessage("thread", { role: "user", kind: "text", text, sendId: options.sendId, replyToId: options.replyTo?.id });
    store.patchBot(bot.id, { busy: true });
    return startedTurn(message);
  });
  const pull = vi.fn(() => sync.pull("thread"));
  const steer = vi.fn(async () => false);
  const noop = () => {};
  const deps = {
    cfg: {}, threadSyncGate: { enabled: true }, registry: new Map([["fake", { adapter: { capabilities: { queueing: true }, steer, interruptTurn: async () => {} } }]]),
    store, startTurn, sendSequencer: new SendSequencer(), ensureChatLatency: noop, markChatLatency: noop,
    pullSyncedThread: pull, noteTalked: noop, broadcast: noop, resolveReplyTarget: () => undefined,
    botHasActiveTurn: () => false, clearUnattended: noop, resumePaneWakes: noop,
    paneNoteTurnThreads: new Set(), busyResumeThreads: new Set(), drainQueuedSends: drain,
    closeOpenApprovals: noop, routines: { activeRunForBot: () => null }, taskResumes: { forgetBot: noop },
  } as unknown as Parameters<typeof createBotChatRoutes>[0];
  const routes = createBotChatRoutes(deps);
  const post = async (body: object, stop = false) => {
    let status = 0;
    let response: Record<string, any> = {};
    const res = { writeHead: (value: number) => { status = value; }, end: (value: string) => { response = JSON.parse(value); } } as unknown as ServerResponse;
    const req = Readable.from([JSON.stringify(body)]) as IncomingMessage;
    await (stop ? routes.interrupt : routes.send)(req, res, ["", bot.id] as RegExpMatchArray);
    return { status, body: response };
  };
  const own = messageDatabase().prepare("SELECT writer FROM sync_v2_identity WHERE id = 1").get()!.writer as string;
  const seq = Number(messageDatabase().prepare("SELECT seq FROM sync_v2_progress WHERE thread = 'thread' AND writer = ?").get(own)!.seq);
  const context = { [own]: seq };
  const versions: SyncVersion[] = [
    { seq: 1, seen: context, kind: "row", rowId: "peer-first", origin: "peer", baseStamp: null, value: { id: "peer-first", parentId: local, at: 2, role: "user", kind: "text", text: "peer first" } },
    { seq: 2, seen: { ...context, peer: 1 }, kind: "head", rowId: "", baseStamp: null, value: "peer-first" },
    { seq: 3, seen: { ...context, peer: 2 }, kind: "row", rowId: "peer-tip", origin: "peer", baseStamp: null, value: { id: "peer-tip", parentId: "peer-first", at: 3, role: "bot", kind: "text", text: "peer tip" } },
    { seq: 4, seen: { ...context, peer: 3 }, kind: "head", rowId: "", baseStamp: "2:peer", value: "peer-tip" },
  ];
  const packet = (cut: number, last: number): SyncHead => ({
    v: 2, threadId: "thread", writerId: "peer", generation: 1, sealedThrough: cut, firstSeq: cut + 1,
    lastSeq: last, seen: { ...context, peer: last }, versions: versions.slice(cut, last),
  });
  const headPath = "threads-v2/bot/thread/peer/head.json";
  const write = (path: string, bytes: string | Buffer) => {
    const target = join(folder, ...path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  };
  const head = JSON.stringify(packet(2, 4));
  const deliverHead = () => write(headPath, head);
  const deliverSegment = () => write("threads-v2/bot/thread/peer/seg-1-2.json.gz", gzipSync(JSON.stringify(packet(0, 2))));
  const send = (text = "new send", sendId = "sync-hold-send-0001", queueId?: string) => post({ text, sendId, queueId, threadId: "thread" });
  close = async () => {
    sync.stop();
    queue._resetSteerQueue();
    await sync.close();
    closeMessageDb();
    close = async () => {};
  };
  return { dataDir, folder, store, bot, queue, sync, pull, run, contexts, startTurn, steer, drain, post, send, local, own, headPath, head, versions, deliverHead, deliverSegment, disable: () => { enabled = false; } };
}

async function googlePC(early?: Awaited<ReturnType<typeof boot>>) {
  const h = early ?? await boot(true);
  const { createDriveClient } = await import("./drive-client.ts");
  const { createDriveMirror, drivePathHash, encodeDrivePath } = await import("./drive-mirror.ts");
  const { createGoogleSync } = await import("./google-sync.ts");
  const { GoogleAccount } = await import("./google-account.ts");
  const drive = new FakeDrive();
  const account = new GoogleAccount({ id: "test", secret: "test" }, null, {
    fetch: async () => Response.json({ access_token: "test-access", expires_in: 3600 }), log: () => {},
  });
  account.setSession({ sub: "account-a", email: "test@example.com", refreshToken: "test-refresh" });
  const owner = { issuer: "https://accounts.google.com", sub: "account-a" } as const;
  const statePath = join(h.dataDir, "google-drive-table.json");
  const ids = { profileDeviceId: "local", writerId: h.own, memoryDeviceId: "a".repeat(12) };
  let failed = false;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return failed && url.pathname === "/drive/v3/changes" ? new Response(null, { status: 500 }) : drive.fetch(input, init);
  };
  await createDriveMirror({ owner, mirrorPath: h.folder, statePath, ownIds: ids, client: createDriveClient({ getAccessToken: async () => "test-access", fetch }) }).syncOnce();
  writeFileSync(join(h.dataDir, "google-binding.json"), JSON.stringify({
    version: 1, spaceId: "space", owner, emailHint: "test@example.com", transport: "google-drive", rootId: drive.root().id,
    mirrorPath: h.folder, transportStatePath: statePath, workspaceId: "workspace", heldBots: [], phase: "ready",
  }));
  const google = createGoogleSync({
    dataDir: h.dataDir, account, folder: () => h.folder, prepare: () => {}, unusedBots: () => [], activate: () => "workspace",
    ownIds: () => ids, fetch, pull: () => { void h.sync.pull("thread"); }, log: () => {},
  });
  const finish = close;
  close = async () => { releaseDownload(); google.stop(); await google.idle(); await finish(); };
  const listed = async (head = h.head) => {
    const gate = new Promise<void>((resolve) => { releaseDownload = resolve; });
    let downloading = false;
    drive.onDownload = async () => { downloading = true; await gate; };
    const file = drive.add(encodeDrivePath(h.headPath), { ph: drivePathHash(h.headPath) }, Buffer.from(head), [drive.root().id]);
    const pass = google.kick();
    await vi.waitFor(() => expect(downloading).toBe(true));
    return { pass, release: releaseDownload, file };
  };
  return { ...h, google, account, drive, listed, fail: () => { failed = true; } };
}

const expectHeld = (receipt: Awaited<ReturnType<Awaited<ReturnType<typeof boot>>["send"]>>) => {
  expect(receipt.status).toBe(202);
  expect(receipt.body).toMatchObject({ queued: true, reason: "sync", threadId: "thread" });
};

describe("sends while a chat catches up", () => {
  it("holds a delivered peer head after the route pull, then appends on its tip and starts once", async () => {
    const h = await boot();
    h.deliverHead();
    expectHeld(await h.send());
    expect(h.startTurn).not.toHaveBeenCalled();
    expect(h.store.activeLeaf("thread")).toBe(h.local);
    h.drain();
    expect(h.run).not.toHaveBeenCalled();
    h.deliverSegment();
    await h.sync.pull("thread");
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(1));
    h.drain();
    expect(h.run.mock.calls[0]![3]).toMatchObject({ parentId: "peer-tip", sendId: "sync-hold-send-0001" });
    expect(h.contexts[0]!.map((m) => m.text)).toEqual(["local", "peer first", "peer tip", "new send"]);
    expect(h.store.messagesFor("thread").filter((m) => m.sendId === "sync-hold-send-0001")).toHaveLength(1);
  });

  it("holds a peer head listed by the feed before it is delivered", async () => {
    const h = await googlePC();
    const pending = await h.listed();
    expectHeld(await h.send());
    expect(h.startTurn).not.toHaveBeenCalled();
    pending.release();
    await pending.pass;
    h.deliverSegment();
    await h.sync.pull("thread");
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(1));
    expect(h.run.mock.calls[0]![3]?.parentId).toBe("peer-tip");
  });

  it("names a listed peer update to a bot's chats as incoming until the store takes it in", async () => {
    const h = await googlePC();
    const { syncHold } = await import("./sync-hold.ts");
    expect(syncHold.incoming("bot", ["thread"])).toBe(false);
    const pending = await h.listed();
    expect(syncHold.incoming("bot", [])).toBe(true);
    expect(syncHold.incoming("other-bot", ["other"])).toBe(false);
    pending.release();
    await pending.pass;
    h.deliverSegment();
    await h.sync.pull("thread");
    expect(syncHold.incoming("bot", ["thread"])).toBe(false);
  });

  it("releases a listed Google head on stop when the data folder uses a junction", async () => {
    const early = await boot(true);
    const dataDir = join(root, "linked-data");
    symlinkSync(early.dataDir, dataDir, "junction");
    const h = await googlePC({ ...early, dataDir, folder: realpathSync(early.folder) });
    const pending = await h.listed();
    const { syncHold } = await import("./sync-hold.ts");
    expect(syncHold.until("thread")).toBeGreaterThan(Date.now());
    h.google.stop();
    expect((await h.send("after stop", "sync-hold-junction-stop-0001")).body.queued).not.toBe(true);
    pending.release();
    await pending.pass;
  });

  it("keeps a listed peer head held when it arrives as the transport pull finishes", async () => {
    const h = await googlePC();
    const pending = await h.listed();
    const { ThreadSyncV2 } = await import("./thread-sync-v2.ts");
    const pull = ThreadSyncV2.prototype.pull;
    vi.spyOn(ThreadSyncV2.prototype, "pull").mockImplementationOnce(function (this: ThreadSyncV2, scope) {
      return pull.call(this, scope).then((result) => { h.deliverHead(); return result; });
    });
    expectHeld(await h.send());
    expect(h.startTurn).not.toHaveBeenCalled();
    pending.release();
    await pending.pass;
    h.deliverSegment();
    await h.sync.pull("thread");
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(1));
    expect(h.run.mock.calls[0]![3]?.parentId).toBe("peer-tip");
  });

  it("sends on the local leaf at ten seconds even if the peer is still behind", async () => {
    const h = await boot();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    h.deliverHead();
    expectHeld(await h.send());
    await vi.advanceTimersByTimeAsync(9_999);
    expect(h.run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.run.mock.calls[0]![3]?.parentId).toBe(h.local);
  });

  it("keeps the later deadline when the earlier chat's bot is busy", async () => {
    const h = await boot();
    const { syncHold } = await import("./sync-hold.ts");
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    h.deliverHead();
    expectHeld(await h.send());
    h.store.patchBot(h.bot.id, { busy: true });
    await vi.advanceTimersByTimeAsync(1_000);
    const later = h.store.createBot({}, { seedMessages: false });
    h.store.adoptSyncedTask(later.id, { threadId: "later", title: "Later", createdAt: 1 }, [], null, true);
    syncHold.pulled(h.folder, { botSyncId: "later-bot", threadId: "later" }, [{
      path: "threads-v2/later-bot/later/peer/head.json", hash: "later-head", writer: "peer", lastSeq: 4, seen: {},
    }]);
    h.queue.queueSteeredMessage(later.id, "later", "later send", { syncUntil: syncHold.until("later") });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(h.run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(h.run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.run.mock.calls[0]!.slice(0, 3)).toEqual([later.id, "later", "later send"]);
    h.sync.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    h.store.patchBot(h.bot.id, { busy: false });
    h.drain();
    expect(h.run).toHaveBeenCalledTimes(2);
    expect(h.run.mock.calls[1]![1]).toBe("thread");
  });

  it("re-arms when the timeout fires one millisecond before the wall clock deadline", async () => {
    const h = await boot();
    let now = Date.now();
    const deadline = now + 10_000;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(Date, "now").mockImplementation(() => now);
    h.deliverHead();
    expectHeld(await h.send());
    now = deadline - 1;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.run).not.toHaveBeenCalled();
    h.sync.stop();
    expect(vi.getTimerCount()).toBe(1);
    now = deadline;
    await vi.advanceTimersByTimeAsync(1);
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.run.mock.calls[0]![3]?.parentId).toBe(h.local);
    h.sync.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["off", "signed-out", "failed-feed"])("does not hold after Google becomes %s", async (state) => {
    const h = await googlePC();
    const pending = await h.listed();
    expectHeld(await h.send());
    pending.release();
    await pending.pass;
    await h.sync.pull("thread");
    h.queue.cancelQueuedSends(h.bot.id);
    if (state === "off") { h.disable(); h.google.stop(); }
    if (state === "signed-out") h.account.setSession(null);
    if (state === "failed-feed") { h.fail(); await h.google.kick(); }
    const receipt = await h.send("offline send", "sync-hold-offline-0001");
    expect(receipt.body.queued).not.toBe(true);
    expect(h.startTurn).toHaveBeenCalledTimes(1);
    expect(receipt.body.message.parentId).toBe(h.local);
  });

  it("restores the durable hold after restart and drains it on the caught-up leaf", async () => {
    const h = await boot();
    h.deliverHead();
    const receipt = await h.send();
    expectHeld(receipt);
    expect(JSON.parse(readFileSync(join(h.dataDir, "queued-sends.json"), "utf8"))[0].items[0]).toMatchObject({ syncUntil: expect.any(Number), sendId: "sync-hold-send-0001" });
    const restarted = await boot();
    restarted.drain();
    expect(restarted.run).not.toHaveBeenCalled();
    restarted.deliverSegment();
    await restarted.sync.pull("thread");
    await vi.waitFor(() => expect(restarted.run).toHaveBeenCalledTimes(1));
    expect(restarted.run.mock.calls[0]![3]).toMatchObject({ queueId: receipt.body.queueId, parentId: "peer-tip" });
    expect(JSON.parse(readFileSync(join(h.dataDir, "queued-sends.json"), "utf8"))).toEqual([]);
  });

  it("Send now releases an idle held send immediately and retries cannot duplicate it", async () => {
    const h = await boot();
    h.deliverHead();
    const held = await h.send();
    expectHeld(held);
    const receipt = await h.send("new send", "sync-hold-send-0001", held.body.queueId);
    expect(receipt.body.message).toMatchObject({ parentId: h.local, sendId: "sync-hold-send-0001" });
    await h.send("new send", "sync-hold-send-0001", held.body.queueId);
    h.drain();
    expect(h.startTurn).toHaveBeenCalledTimes(1);
    expect(h.queue._queuedCount("thread")).toBe(0);
  });

  it("Stop returns the held send and later sync cannot dispatch it", async () => {
    const h = await boot();
    h.deliverHead();
    const held = await h.send();
    expectHeld(held);
    const stopped = await h.post({}, true);
    expect(stopped.body.returned).toEqual([{ threadId: "thread", queueId: held.body.queueId, sendId: "sync-hold-send-0001", text: "new send" }]);
    h.deliverSegment();
    await h.sync.pull("thread");
    h.drain();
    expect(h.run).not.toHaveBeenCalled();
    expect((await h.send()).body.cancelled).toBe(true);
  });

  it("coalesces the same sendId into one durable hold", async () => {
    const h = await boot();
    h.deliverHead();
    const [first, second] = await Promise.all([h.send(), h.send()]);
    expectHeld(first);
    expectHeld(second);
    expect(second.body.queueId).toBe(first.body.queueId);
    expect((await h.send()).body.queueId).toBe(first.body.queueId);
    expect(h.queue._queuedCount("thread")).toBe(1);
    h.deliverSegment();
    await h.sync.pull("thread");
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(1));
  });

  it("sends immediately once caught up without saving another queue receipt", async () => {
    const h = await boot();
    h.deliverHead();
    expectHeld(await h.send());
    h.queue.cancelQueuedSends(h.bot.id);
    h.deliverSegment();
    await h.sync.pull("thread");
    const queued = readFileSync(join(h.dataDir, "queued-sends.json"), "utf8");
    const receipt = await h.send("caught up", "sync-hold-caught-up-0001");
    expect(receipt.body.queued).not.toBe(true);
    expect(receipt.body.message.parentId).toBe("peer-tip");
    expect(h.startTurn).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(h.dataDir, "queued-sends.json"), "utf8")).toBe(queued);
  });

  it("keeps steering and after-turn queueing when a turn is running", async () => {
    const h = await boot();
    h.deliverHead();
    expectHeld(await h.send());
    h.queue.cancelQueuedSends(h.bot.id);
    h.store.patchBot(h.bot.id, { busy: true });
    const receipt = await h.send("while busy", "sync-hold-busy-0001");
    expect(receipt.body).toMatchObject({ queued: true });
    expect(receipt.body.reason).toBeUndefined();
    expect(h.steer).toHaveBeenCalledTimes(1);
  });

  it.each(["missing-segments", "rejected-head"])("holds only once at ten seconds with %s", async (state) => {
    const google = state === "rejected-head" ? await googlePC() : null;
    const h = google ?? await boot();
    if (google) {
      const pending = await google.listed("rejected head");
      pending.release();
      await pending.pass;
    } else h.deliverHead();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    expectHeld(await h.send());
    await vi.advanceTimersByTimeAsync(9_999);
    expect(h.run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.run).toHaveBeenCalledTimes(1);
    h.store.patchBot(h.bot.id, { busy: false });
    const next = await h.send("later send", "sync-hold-later-0001");
    expect(next.body.queued).not.toBe(true);
    expect(h.startTurn).toHaveBeenCalledTimes(1);
    expect(h.queue._queuedCount("thread")).toBe(0);
  });

  it.each(["missing-segments", "rejected-head"])("Send now spends the hold with %s", async (state) => {
    const google = state === "rejected-head" ? await googlePC() : null;
    const h = google ?? await boot();
    if (google) {
      const pending = await google.listed("rejected head");
      pending.release();
      await pending.pass;
    } else h.deliverHead();
    const held = await h.send();
    expectHeld(held);
    await h.send("new send", "sync-hold-send-0001", held.body.queueId);
    h.store.patchBot(h.bot.id, { busy: false });
    const next = await h.send("later send", "sync-hold-later-0001");
    expect(next.body.queued).not.toBe(true);
    expect(h.startTurn).toHaveBeenCalledTimes(2);
  });

  it.each(["timeout", "Send now"])("does not re-arm a listed head on its first pull after %s", async (release) => {
    const h = await googlePC();
    const pending = await h.listed();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const held = await h.send();
    expectHeld(held);
    if (release === "timeout") {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.run).toHaveBeenCalledTimes(1);
    } else await h.send("new send", "sync-hold-send-0001", held.body.queueId);
    h.store.patchBot(h.bot.id, { busy: false });
    pending.release();
    await pending.pass;
    await h.sync.pull("thread");
    expect((await h.send("same listed head", "sync-hold-listed-same-0001")).body.queued).not.toBe(true);
  });

  it("holds a new listed hash once after the previous hold is spent", async () => {
    const h = await googlePC();
    const first = await h.listed();
    first.release();
    await first.pass;
    await h.sync.pull("thread");
    const held = await h.send();
    expectHeld(held);
    await h.send("new send", "sync-hold-send-0001", held.body.queueId);
    h.store.patchBot(h.bot.id, { busy: false });
    const head: SyncHead = JSON.parse(h.head);
    head.generation++;
    await h.listed(JSON.stringify(head));
    const next = await h.send("new listed head", "sync-hold-listed-new-0001");
    expectHeld(next);
    await h.send("new listed head", "sync-hold-listed-new-0001", next.body.queueId);
    h.store.patchBot(h.bot.id, { busy: false });
    expect((await h.send("same new head", "sync-hold-listed-once-0001")).body.queued).not.toBe(true);
  });

  it("does not re-arm an older pull after spending a newer listed hash", async () => {
    const h = await googlePC();
    const first = await h.listed();
    first.release();
    await first.pass;
    await h.sync.pull("thread");
    const head: SyncHead = JSON.parse(h.head);
    head.generation++;
    await h.listed(JSON.stringify(head));
    const held = await h.send();
    expectHeld(held);
    await h.send("new send", "sync-hold-send-0001", held.body.queueId);
    h.store.patchBot(h.bot.id, { busy: false });
    await h.sync.pull("thread");
    expect((await h.send("older local head", "sync-hold-older-pull-0001")).body.queued).not.toBe(true);
  });

  it("does not re-arm the first listing of a hash pulled before Google started", async () => {
    const early = await boot(true);
    early.deliverHead();
    const held = await early.send();
    expectHeld(held);
    await early.send("new send", "sync-hold-send-0001", held.body.queueId);
    early.store.patchBot(early.bot.id, { busy: false });
    const h = await googlePC(early);
    const { drivePathHash, encodeDrivePath } = await import("./drive-mirror.ts");
    h.drive.add(encodeDrivePath(h.headPath), { ph: drivePathHash(h.headPath) }, Buffer.from(h.head), [h.drive.root().id]);
    await h.google.kick();
    expect((await h.send("first listing", "sync-hold-first-listing-0001")).body.queued).not.toBe(true);
  });

  it("starts at once after a restart when an idle chat lists only this PC's head", async () => {
    await boot(true);
    const h = await boot(true);
    const { syncHold } = await import("./sync-hold.ts");
    const ids = { profileDeviceId: "local", writerId: h.own, memoryDeviceId: "a".repeat(12) };
    syncHold.feed(h.folder, new Map([[`threads-v2/bot/thread/${h.own}/head.json`, [{
      id: "own", name: "head.json", md5Checksum: "a".repeat(32), createdTime: "2026-11-17T00:00:00Z", modifiedTime: "2026-11-17T00:00:00Z", trashed: false,
    }]]]), ids);
    expect((await h.send()).body.queued).not.toBe(true);
    expect(h.startTurn).toHaveBeenCalledTimes(1);
  });

  it("starts at once after a restart when Drive still lists an older copy of an applied peer head", async () => {
    const first = await boot(true);
    first.deliverSegment();
    const current = JSON.stringify({ ...JSON.parse(first.head), generation: 111 });
    writeFileSync(join(first.folder, first.headPath), current);
    await first.sync.pull("thread");
    const stalePath = "threads-v2 (1)/bot/thread/peer/head.json";
    const stale = JSON.stringify({ ...JSON.parse(gunzipSync(readFileSync(join(first.folder, "threads-v2/bot/thread/peer/seg-1-2.json.gz"))).toString()), generation: 5 });
    mkdirSync(dirname(join(first.folder, stalePath)), { recursive: true });
    writeFileSync(join(first.folder, stalePath), stale);
    const h = await boot(true);
    const { syncHold } = await import("./sync-hold.ts");
    const ids = { profileDeviceId: "local", writerId: h.own, memoryDeviceId: "a".repeat(12) };
    const listed = (id: string, bytes: string | Buffer) => [{
      id, name: "head.json", md5Checksum: createHash("md5").update(bytes).digest("hex"),
      createdTime: "2026-11-17T00:00:00Z", modifiedTime: "2026-11-17T00:00:00Z", trashed: false,
    }];
    syncHold.feed(h.folder, new Map([[h.headPath, listed("head", current)], [stalePath, listed("stale", stale)]]), ids);
    expect((await h.send()).body.queued).not.toBe(true);
    expect(h.startTurn).toHaveBeenCalledTimes(1);
  });

  it.each(["changed bytes", "a conflicting sequence"])("holds a rejected head with %s and appends on the corrected peer row", async (kind) => {
    const h = await boot(true);
    h.deliverSegment();
    h.deliverHead();
    await h.sync.pull("thread");
    const { syncHold } = await import("./sync-hold.ts");
    const ids = { profileDeviceId: "local", writerId: h.own, memoryDeviceId: "a".repeat(12) };
    const list = (bytes: string) => syncHold.feed(h.folder, new Map([[h.headPath, [{
      id: "head", name: "head.json", md5Checksum: createHash("md5").update(bytes).digest("hex"),
      createdTime: "2026-11-17T00:00:00Z", modifiedTime: "2026-11-17T00:00:00Z", trashed: false,
    }]]]), ids);
    let bad = h.head.replace('"peer tip"', '"conflicting bytes"');
    if (kind !== "changed bytes") bad = bad.replace('"generation":1', '"generation":2');
    writeFileSync(join(h.folder, h.headPath), bad);
    list(bad);
    expectHeld(await h.send());
    const doc: SyncHead = JSON.parse(h.head);
    const corrected = JSON.stringify({ ...doc, generation: 3, lastSeq: 6, seen: { ...doc.seen, peer: 6 }, versions: [...doc.versions,
      { seq: 5, seen: { ...doc.seen, peer: 4 }, kind: "row", rowId: "peer-six", origin: "peer", baseStamp: null, value: { id: "peer-six", parentId: "peer-tip", at: 4, role: "user", kind: "text", text: "peer correction" } },
      { seq: 6, seen: { ...doc.seen, peer: 5 }, kind: "head", rowId: "", baseStamp: "4:peer", value: "peer-six" },
    ] });
    list(corrected);
    writeFileSync(join(h.folder, h.headPath), corrected);
    await h.sync.pull("thread");
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(1));
    expect(h.run.mock.calls[0]![3]?.parentId).toBe("peer-six");
  });

  it.each(["matching", "different"])("checks an older copy with %s stored packets before it clears the hold", async (kind) => {
    const h = await boot(true);
    h.deliverSegment();
    const doc: SyncHead = { ...JSON.parse(h.head), generation: 111 };
    writeFileSync(join(h.folder, h.headPath), JSON.stringify(doc));
    await h.sync.pull("thread");
    const { syncHold } = await import("./sync-hold.ts");
    const ids = { profileDeviceId: "local", writerId: h.own, memoryDeviceId: "a".repeat(12) };
    const copyPath = "threads-v2 (1)/bot/thread/peer/head.json";
    const list = (bytes: string) => syncHold.feed(h.folder, new Map([[h.headPath, JSON.stringify(doc)], [copyPath, bytes]].map(([path, data]) => [path, [{
      id: path, name: "head.json", md5Checksum: createHash("md5").update(data).digest("hex"),
      createdTime: "2026-11-17T00:00:00Z", modifiedTime: "2026-11-17T00:00:00Z", trashed: false,
    }]])), ids);
    const older: SyncHead = structuredClone({ ...doc, generation: 110, lastSeq: 3, seen: { ...doc.seen, peer: 3 }, versions: doc.versions.slice(0, 1) });
    if (kind === "different") (older.versions[0]!.value as Message).text = "different sequence three";
    mkdirSync(dirname(join(h.folder, copyPath)), { recursive: true });
    writeFileSync(join(h.folder, copyPath), JSON.stringify(older));
    await h.sync.pull("thread");
    list(JSON.stringify(older));
    const receipt = await h.send();
    if (kind === "matching") {
      expect(receipt.body.queued).not.toBe(true);
      expect(h.startTurn).toHaveBeenCalledTimes(1);
      return;
    }
    expectHeld(receipt);
    const corrected = JSON.stringify({ ...doc, generation: 113, lastSeq: 6, seen: { ...doc.seen, peer: 6 }, versions: [...doc.versions,
      { seq: 5, seen: { ...doc.seen, peer: 4 }, kind: "row", rowId: "peer-six", origin: "peer", baseStamp: null, value: { id: "peer-six", parentId: "peer-tip", at: 4, role: "user", kind: "text", text: "peer correction" } },
      { seq: 6, seen: { ...doc.seen, peer: 5 }, kind: "head", rowId: "", baseStamp: "4:peer", value: "peer-six" },
    ] });
    list(corrected);
    writeFileSync(join(h.folder, copyPath), corrected);
    await h.sync.pull("thread");
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(1));
    expect(h.run.mock.calls[0]![3]?.parentId).toBe("peer-six");
  });

  const copies = (["lower", "equal", "higher"] as const).flatMap((generation) => (["same", "different"] as const)
    .flatMap((bytes) => (["stored", "later", "next", "sealed", "spanning"] as const).map((packets) => ({ generation, bytes, packets }))));
  it.each(copies)("holds a $generation generation copy with $bytes $packets packets only while a correction is due", async ({ generation, bytes, packets }) => {
    const h = await boot(true);
    h.deliverSegment();
    const segmentPath = "threads-v2/bot/thread/peer/seg-1-2.json.gz";
    const sealed: SyncHead = JSON.parse(gunzipSync(readFileSync(join(h.folder, segmentPath))).toString());
    if (packets === "later") rmSync(join(h.folder, segmentPath));
    const doc: SyncHead = { ...JSON.parse(h.head), generation: 111 };
    writeFileSync(join(h.folder, h.headPath), JSON.stringify(doc));
    await h.sync.pull("thread");
    const { syncHold } = await import("./sync-hold.ts");
    const ids = { profileDeviceId: "local", writerId: h.own, memoryDeviceId: "a".repeat(12) };
    const copyPath = "threads-v2 (1)/bot/thread/peer/head.json";
    const list = (listed: string) => syncHold.feed(h.folder, new Map([[h.headPath, JSON.stringify(doc)], [copyPath, listed]].map(([path, data]) => [path, [{
      id: path, name: "head.json", md5Checksum: createHash("md5").update(data).digest("hex"),
      createdTime: "2026-11-17T00:00:00Z", modifiedTime: "2026-11-17T00:00:00Z", trashed: false,
    }]])), ids);
    const put = (path: string, data: string | Buffer) => {
      mkdirSync(dirname(join(h.folder, path)), { recursive: true });
      writeFileSync(join(h.folder, path), data);
    };
    // An equal or newer head cannot shrink its sealed prefix, so only an older copy carries the packets a later root supplies.
    const unsealed = packets === "later" && generation === "lower" ? { sealedThrough: 0, firstSeq: 1, versions: [...sealed.versions, ...doc.versions] } : {};
    const copy: SyncHead = structuredClone({ ...doc, generation: { lower: 110, equal: 111, higher: 112 }[generation], ...unsealed });
    // The copy's folder seals 1-2 before the first pull or after it, or in one segment that runs past its cut.
    const own: SyncHead = structuredClone(packets === "spanning" ? { ...sealed, lastSeq: 3, seen: { ...sealed.seen, peer: 3 }, versions: [...sealed.versions, doc.versions[0]!] } : sealed);
    const segment = packets === "next" || packets === "sealed" || packets === "spanning";
    // SAFETY: the first version each copy carries is a text row.
    const first = (segment ? own : copy).versions[0]!.value as Message;
    if (bytes === "different") first.text = "different bytes";
    const seal = () => put(`threads-v2 (1)/bot/thread/peer/seg-1-${own.lastSeq}.json.gz`, gzipSync(JSON.stringify(own)));
    if (packets === "later") put("threads-v2 (2)/bot/thread/peer/seg-1-2.json.gz", gzipSync(JSON.stringify(sealed)));
    if (packets === "sealed" || packets === "spanning") seal();
    put(copyPath, JSON.stringify(copy));
    list(JSON.stringify(copy));
    if (packets === "next") {
      await h.sync.pull("thread");
      expect(syncHold.until("thread")).toBeUndefined();
      seal();
    }
    const receipt = await h.send();
    // Equal and newer copies keep base, where a segment beside an applied head never holds a send.
    if (bytes === "same" || (generation !== "lower" && segment)) {
      expect(receipt.body.queued).not.toBe(true);
      expect(h.store.messagesFor("thread").find((row) => row.sendId === "sync-hold-send-0001")?.parentId).toBe("peer-tip");
      return;
    }
    expectHeld(receipt);
    const corrected = JSON.stringify({ ...doc, generation: 113, lastSeq: 6, seen: { ...doc.seen, peer: 6 }, versions: [...doc.versions,
      { seq: 5, seen: { ...doc.seen, peer: 4 }, kind: "row", rowId: "peer-six", origin: "peer", baseStamp: null, value: { id: "peer-six", parentId: "peer-tip", at: 4, role: "user", kind: "text", text: "peer correction" } },
      { seq: 6, seen: { ...doc.seen, peer: 5 }, kind: "head", rowId: "", baseStamp: "4:peer", value: "peer-six" },
    ] });
    list(corrected);
    put(copyPath, corrected);
    await h.sync.pull("thread");
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(1));
    expect(h.run.mock.calls[0]![3]?.parentId).toBe("peer-six");
  });

  const conflicts = [1, 2, 3, 4].flatMap((seq) => [
    { position: "below", seq, cut: seq + 1, first: seq, last: seq },
    { position: "at", seq, cut: seq, first: 1, last: seq },
    { position: "above", seq, cut: seq - 1, first: seq, last: 4 },
    { position: "spanning", seq, cut: 2, first: 1, last: Math.max(seq, 3) },
  ]).filter(({ cut }) => cut < 4);
  const matching = [...new Map(conflicts.map((layout) => [`${layout.cut}:${layout.first}-${layout.last}`, { ...layout, seq: 0 }])).values()];
  const fuzz = [...conflicts, ...matching].flatMap((layout) => (["stored", "same pull", "next pull", "after a matching segment"] as const)
    .map((arrival) => ({ ...layout, arrival, differs: layout.seq ? `differs at ${layout.seq}, ${layout.position} the seal` : "matches" })));
  it.each(fuzz)("holds a send beside a copy sealed at $cut whose seg-$first-$last $differs ($arrival) only while a correction is due", async ({ seq, cut, first, last, arrival }) => {
    const h = await boot(true);
    h.deliverSegment();
    const doc: SyncHead = { ...JSON.parse(h.head), generation: 111 };
    writeFileSync(join(h.folder, h.headPath), JSON.stringify(doc));
    await h.sync.pull("thread");
    const { syncHold } = await import("./sync-hold.ts");
    const ids = { profileDeviceId: "local", writerId: h.own, memoryDeviceId: "a".repeat(12) };
    const list = (listed: string) => syncHold.feed(h.folder, new Map([[h.headPath, JSON.stringify(doc)], ["threads-v2 (1)/bot/thread/peer/head.json", listed]].map(([path, data]) => [path, [{
      id: path, name: "head.json", md5Checksum: createHash("md5").update(data).digest("hex"),
      createdTime: "2026-11-17T00:00:00Z", modifiedTime: "2026-11-17T00:00:00Z", trashed: false,
    }]])), ids);
    const dir = join(h.folder, "threads-v2 (1)/bot/thread/peer");
    mkdirSync(dir, { recursive: true });
    // SAFETY: the fixture's rows carry a message.
    const changed = h.versions.map((packet) => packet.seq !== seq ? packet : { ...packet, value: packet.kind === "row" ? { ...packet.value as Message, text: "different bytes" } : packet.value === "peer-first" ? h.local : "peer-first" });
    const part = (generation: number, from: number, to: number, packets = h.versions): SyncHead =>
      ({ ...doc, generation, sealedThrough: from, firstSeq: from + 1, lastSeq: to, seen: { ...doc.seen, peer: to }, versions: packets.slice(from, to) });
    const segment = (from: number, to: number, packets = h.versions) => () => writeFileSync(join(dir, `seg-${from}-${to}.json.gz`), gzipSync(JSON.stringify(part(1, from - 1, to, packets))));
    const copy = JSON.stringify(part(5, cut, 4));
    const head = () => {
      writeFileSync(join(dir, "head.json"), copy);
      list(copy);
    };
    const conflict = segment(first, last, changed);
    // What lands before each pull; the send runs the last one.
    const steps = { "stored": [[conflict], [head]], "same pull": [[conflict, head]], "next pull": [[head], [conflict]], "after a matching segment": [[segment(1, 1), head], [conflict]] }[arrival];
    for (const [index, step] of steps.entries()) {
      if (index) {
        await h.sync.pull("thread");
        expect(syncHold.until("thread")).toBeUndefined();
      }
      for (const land of step) land();
    }
    const receipt = await h.send();
    if (!seq) {
      expect(receipt.body.queued).not.toBe(true);
      expect(h.store.messagesFor("thread").find((row) => row.sendId === "sync-hold-send-0001")?.parentId).toBe("peer-tip");
      return;
    }
    expectHeld(receipt);
    const corrected = JSON.stringify({ ...doc, generation: 113, lastSeq: 6, seen: { ...doc.seen, peer: 6 }, versions: [...doc.versions,
      { seq: 5, seen: { ...doc.seen, peer: 4 }, kind: "row", rowId: "peer-six", origin: "peer", baseStamp: null, value: { id: "peer-six", parentId: "peer-tip", at: 4, role: "user", kind: "text", text: "peer correction" } },
      { seq: 6, seen: { ...doc.seen, peer: 5 }, kind: "head", rowId: "", baseStamp: "4:peer", value: "peer-six" },
    ] });
    list(corrected);
    writeFileSync(join(dir, "head.json"), corrected);
    await h.sync.pull("thread");
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(1));
    expect(h.run.mock.calls[0]![3]?.parentId).toBe("peer-six");
  });

  // The primary folder keeps the applied head, so only the copy's segment lands there.
  const rooted = [...conflicts.filter(({ seq }) => seq === 2), { position: "head", seq: 2, cut: 1, first: 1, last: 1 }]
    .flatMap((layout) => [layout, { ...layout, seq: 0 }])
    .flatMap((layout) => (["own folder", "other dup folder", "primary"] as const).flatMap((root) => (["listed", "unlisted"] as const)
      .flatMap((listing) => (["before", "after"] as const).map((restart) => ({ ...layout, root, listing, restart, differs: layout.seq ? `differs at ${layout.seq}` : "matches" })))));
  it.each(rooted)("holds a send $restart a restart beside a copy ($listing) sealed at $cut with seg-$first-$last in the $root that $differs only while a correction is due", async ({ seq, cut, first, last, root, listing, restart }) => {
    let h = await boot(true);
    h.deliverSegment();
    const doc: SyncHead = { ...JSON.parse(h.head), generation: 111 };
    writeFileSync(join(h.folder, h.headPath), JSON.stringify(doc));
    await h.sync.pull("thread");
    // SAFETY: the fixture's rows carry a message.
    const changed = h.versions.map((packet) => packet.seq !== seq ? packet : { ...packet, value: packet.kind === "row" ? { ...packet.value as Message, text: "different bytes" } : packet.value === "peer-first" ? h.local : "peer-first" });
    const part = (generation: number, from: number, to: number, packets = h.versions): SyncHead =>
      ({ ...doc, generation, sealedThrough: from, firstSeq: from + 1, lastSeq: to, seen: { ...doc.seen, peer: to }, versions: packets.slice(from, to) });
    const folder = { "own folder": "threads-v2 (1)", "other dup folder": "threads-v2 (2)", "primary": "threads-v2" }[root];
    const copy = `${folder}/bot/thread/peer/head.json`;
    const heads = new Map([[h.headPath, JSON.stringify(doc)], ["threads-v2 (1)/bot/thread/peer/head.json", JSON.stringify(part(5, cut, 4))]]);
    if (root !== "primary") heads.set(copy, JSON.stringify(part(5, cut, 4, changed)));
    const put = (path: string, data: string | Buffer) => {
      mkdirSync(dirname(join(h.folder, path)), { recursive: true });
      writeFileSync(join(h.folder, path), data);
    };
    for (const [path, data] of heads) put(path, data);
    put(`${folder}/bot/thread/peer/seg-${first}-${last}.json.gz`, gzipSync(JSON.stringify(part(1, first - 1, last, changed))));
    await h.sync.pull("thread");
    if (restart === "after") h = await boot(true);
    const { syncHold } = await import("./sync-hold.ts");
    const ids = { profileDeviceId: "local", writerId: h.own, memoryDeviceId: "a".repeat(12) };
    const listed = () => [...heads].filter(([path]) => listing === "listed" || path !== copy);
    const list = () => syncHold.feed(h.folder, new Map(listed().map(([path, data]) => [path, [{
      id: path, name: "head.json", md5Checksum: createHash("md5").update(data).digest("hex"),
      createdTime: "2026-11-17T00:00:00Z", modifiedTime: "2026-11-17T00:00:00Z", trashed: false,
    }]])), ids);
    list();
    const receipt = await h.send();
    // An unlisted copy in its own folder leaves nothing older listed, so base starts too.
    const due = (first <= seq && seq <= last || seq > cut && root !== "primary") && (root !== "own folder" || listing === "listed");
    if (!due) {
      expect(receipt.body.queued).not.toBe(true);
      expect(h.store.messagesFor("thread").find((row) => row.sendId === "sync-hold-send-0001")?.parentId).toBe("peer-tip");
      return;
    }
    expectHeld(receipt);
    const corrected = JSON.stringify({ ...doc, generation: 113, lastSeq: 6, seen: { ...doc.seen, peer: 6 }, versions: [...doc.versions,
      { seq: 5, seen: { ...doc.seen, peer: 4 }, kind: "row", rowId: "peer-six", origin: "peer", baseStamp: null, value: { id: "peer-six", parentId: "peer-tip", at: 4, role: "user", kind: "text", text: "peer correction" } },
      { seq: 6, seen: { ...doc.seen, peer: 5 }, kind: "head", rowId: "", baseStamp: "4:peer", value: "peer-six" },
    ] });
    for (const [path] of listed()) if (path !== h.headPath) {
      heads.set(path, corrected);
      put(path, corrected);
    }
    list();
    await h.sync.pull("thread");
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(1));
    expect(h.run.mock.calls[0]![3]?.parentId).toBe("peer-six");
  });

  // Drive keeps the stale copy in its own folder, so these files land beside it.
  const beside = async () => {
    const h = await boot(true);
    h.deliverSegment();
    const doc: SyncHead = { ...JSON.parse(h.head), generation: 111 };
    writeFileSync(join(h.folder, h.headPath), JSON.stringify(doc));
    await h.sync.pull("thread");
    const { syncHold } = await import("./sync-hold.ts");
    const ids = { profileDeviceId: "local", writerId: h.own, memoryDeviceId: "a".repeat(12) };
    const copyPath = "threads-v2 (1)/bot/thread/peer/head.json";
    const list = (listed: string) => syncHold.feed(h.folder, new Map([[h.headPath, JSON.stringify(doc)], [copyPath, listed]].map(([path, data]) => [path, [{
      id: path, name: "head.json", md5Checksum: createHash("md5").update(data).digest("hex"),
      createdTime: "2026-11-17T00:00:00Z", modifiedTime: "2026-11-17T00:00:00Z", trashed: false,
    }]])), ids);
    const put = (path: string, data: string | Buffer) => {
      mkdirSync(dirname(join(h.folder, path)), { recursive: true });
      writeFileSync(join(h.folder, path), data);
    };
    const copy = JSON.stringify({ ...doc, generation: 5 });
    put(copyPath, copy);
    // SAFETY: the fixture's first packet is a text row.
    const differing = (text: string) => gzipSync(JSON.stringify({ ...JSON.parse(gunzipSync(readFileSync(join(h.folder, "threads-v2/bot/thread/peer/seg-1-2.json.gz"))).toString()),
      versions: h.versions.slice(0, 2).map((packet) => packet.seq === 1 ? { ...packet, value: { ...packet.value as Message, text } } : packet) }), { level: 0 });
    const correct = () => {
      const corrected = JSON.stringify({ ...doc, generation: 113, lastSeq: 6, seen: { ...doc.seen, peer: 6 }, versions: [...doc.versions,
        { seq: 5, seen: { ...doc.seen, peer: 4 }, kind: "row", rowId: "peer-six", origin: "peer", baseStamp: null, value: { id: "peer-six", parentId: "peer-tip", at: 4, role: "user", kind: "text", text: "peer correction" } },
        { seq: 6, seen: { ...doc.seen, peer: 5 }, kind: "head", rowId: "", baseStamp: "4:peer", value: "peer-six" },
      ] });
      list(corrected);
      put(copyPath, corrected);
    };
    return { h, syncHold, list, put, copy, differing, correct };
  };

  it("holds a send beside a matched segment restored with other bytes at the same size and time", async () => {
    const { h, syncHold, list, put, copy, differing, correct } = await beside();
    const segment = join(h.folder, "threads-v2 (8)/bot/thread/peer/seg-1-2.json.gz");
    put("threads-v2 (8)/bot/thread/peer/seg-1-2.json.gz", differing("peer first"));
    utimesSync(segment, 1767225600, 1767225600);
    list(copy);
    await h.sync.pull("thread");
    expect(syncHold.until("thread")).toBeUndefined();
    const before = statSync(segment);
    writeFileSync(segment, differing("peer other"));
    utimesSync(segment, 1767225600, 1767225600);
    expect([statSync(segment).size, statSync(segment).mtimeMs]).toEqual([before.size, before.mtimeMs]);
    list(copy);
    expectHeld(await h.send());
    correct();
    await h.sync.pull("thread");
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(1));
    expect(h.run.mock.calls[0]![3]?.parentId).toBe("peer-six");
  });

  it("keeps holding a send after the folder with a differing segment leaves the mirror", async () => {
    const { h, list, put, copy, differing, correct } = await beside();
    put("threads-v2 (2)/bot/thread/peer/seg-1-2.json.gz", differing("different bytes"));
    list(copy);
    expectHeld(await h.send());
    rmSync(join(h.folder, "threads-v2 (2)"), { recursive: true, maxRetries: 5 });
    await h.sync.pull("thread");
    await new Promise((done) => setImmediate(done));
    expect(h.run).not.toHaveBeenCalled();
    correct();
    await h.sync.pull("thread");
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(1));
    expect(h.run.mock.calls[0]![3]?.parentId).toBe("peer-six");
  });

  it("drops a stale listed hash once the listing matches the applied head", async () => {
    const h = await boot(true);
    const { syncHold } = await import("./sync-hold.ts");
    const ids = { profileDeviceId: "local", writerId: h.own, memoryDeviceId: "a".repeat(12) };
    const listing = (md5Checksum: string) => new Map([[h.headPath, [{
      id: "head", name: "head.json", md5Checksum, createdTime: "2026-10-25T00:00:00Z", modifiedTime: "2026-10-25T00:00:00Z", trashed: false,
    }]]]);
    syncHold.feed(h.folder, listing("a".repeat(32)), ids);
    syncHold.pulled(h.folder, { botSyncId: "bot", threadId: "thread" }, [{ path: h.headPath, hash: "b".repeat(32), writer: "peer", lastSeq: 0, seen: {} }]);
    syncHold.feed(h.folder, listing("b".repeat(32)), ids);
    expect((await h.send()).body.queued).not.toBe(true);
  });

  it("starts a held send as soon as a listing drops its stale hash", async () => {
    const h = await boot(true);
    const { syncHold } = await import("./sync-hold.ts");
    const ids = { profileDeviceId: "local", writerId: h.own, memoryDeviceId: "a".repeat(12) };
    const listing = (md5Checksum: string) => new Map([[h.headPath, [{
      id: "head", name: "head.json", md5Checksum, createdTime: "2026-10-25T00:00:00Z", modifiedTime: "2026-10-25T00:00:00Z", trashed: false,
    }]]]);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    syncHold.feed(h.folder, listing("a".repeat(32)), ids);
    syncHold.pulled(h.folder, { botSyncId: "bot", threadId: "thread" }, [{ path: h.headPath, hash: "b".repeat(32), writer: "peer", lastSeq: 0, seen: {} }]);
    expectHeld(await h.send());
    syncHold.feed(h.folder, listing("b".repeat(32)), ids);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.run).toHaveBeenCalledTimes(1);
  });

  it("holds an unlisted recovery hash once and does not re-arm its later listing", async () => {
    const h = await googlePC();
    const first = await h.listed();
    first.release();
    await first.pass;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    await h.sync.pull("thread");
    const held = await h.send();
    expectHeld(held);
    await h.send("new send", "sync-hold-send-0001", held.body.queueId);
    h.store.patchBot(h.bot.id, { busy: false });
    const head: SyncHead = JSON.parse(h.head);
    head.generation++;
    const fetch = h.drive.fetch;
    let edited = false;
    vi.spyOn(h.drive, "fetch").mockImplementation(async (input, init) => {
      const response = await fetch(input, init);
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (!edited && url.pathname === "/drive/v3/changes") {
        edited = true;
        h.drive.edit(first.file.id, Buffer.from(JSON.stringify(head)));
      }
      return response;
    });
    rmSync(join(h.folder, h.headPath));
    await h.google.kick();
    await h.sync.pull("thread");
    expect(edited).toBe(true);
    const recovered = await h.send("recovered head", "sync-hold-recovered-0001");
    expectHeld(recovered);
    await h.send("recovered head", "sync-hold-recovered-0001", recovered.body.queueId);
    h.store.patchBot(h.bot.id, { busy: false });
    await h.google.kick();
    expect((await h.send("listed recovery", "sync-hold-recovery-listed-0001")).body.queued).not.toBe(true);
  });

  it.each(["feed-md5", "head-hash", "last-seq"])("holds again only after a new %s for the chat", async (state) => {
    const google = state === "feed-md5" ? await googlePC() : null;
    const h = google ?? await boot();
    let change = async () => {};
    if (google) {
      const pending = await google.listed("rejected head");
      pending.release();
      await pending.pass;
      change = async () => { google.drive.edit(pending.file.id, Buffer.from("another rejected head")); await google.google.kick(); };
    } else {
      h.deliverHead();
      change = async () => {
        const head: SyncHead = JSON.parse(h.head);
        head.generation++;
        if (state === "last-seq") {
          head.versions.push({ seq: 5, seen: { ...head.seen }, kind: "head", rowId: "", baseStamp: "4:peer", value: "peer-tip" });
          head.lastSeq = 5;
          head.seen.peer = 5;
        }
        writeFileSync(join(h.folder, h.headPath), `${JSON.stringify(head)}\n`);
      };
    }
    const held = await h.send();
    expectHeld(held);
    await h.send("new send", "sync-hold-send-0001", held.body.queueId);
    h.store.patchBot(h.bot.id, { busy: false });
    expect((await h.send("same peer state", "sync-hold-same-state-0001")).body.queued).not.toBe(true);
    h.store.patchBot(h.bot.id, { busy: false });
    await change();
    expectHeld(await h.send("new peer state", "sync-hold-new-state-0001"));
    expect(h.startTurn).toHaveBeenCalledTimes(2);
  });

  it("holds a changed peer again after a busy turn outlives the deadline", async () => {
    const h = await boot();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    h.deliverHead();
    expectHeld(await h.send());
    h.store.patchBot(h.bot.id, { busy: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.run).not.toHaveBeenCalled();
    const { syncHold } = await import("./sync-hold.ts");
    expect(syncHold.until("thread")).toBeUndefined();
    const head: SyncHead = JSON.parse(h.head);
    head.generation++;
    writeFileSync(join(h.folder, h.headPath), JSON.stringify(head));
    h.store.patchBot(h.bot.id, { busy: false });
    await h.sync.pull("thread");
    expect(h.run).toHaveBeenCalledTimes(1);
    h.store.patchBot(h.bot.id, { busy: false });
    expectHeld(await h.send("changed while busy", "sync-hold-busy-change-0001"));
  });
});
