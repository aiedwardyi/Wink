import { readFileSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { postCommsNotice, postRefusalNotice, refusalText } from "./comms-notice.ts";
import { _resetCommsRoots, rootForStart } from "./comms-root.ts";
import { DATA_DIR } from "./config.ts";
import { Store } from "./store.ts";

const PAUSED = "Bot messaging limit reached. Send a message to reset it.";
const UNAVAILABLE = "Bot messaging paused. Send a message to reset it.";

let store: Store;
let bot: ReturnType<Store["createBot"]>;
let peer: ReturnType<Store["createBot"]>;
let key = 0;
const lines = (threadId: string) => store.messagesFor(threadId).filter((row) => row.tool?.name?.startsWith("Bot messaging"));

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  _resetCommsRoots();
  store = new Store(() => ({ instanceId: "claude", model: "fake" }));
  bot = store.createBot();
  peer = store.createBot();
  key++;
});
afterEach(() => {
  vi.useRealTimers();
});

it("gives the bot the three fixed refusal texts", () => {
  expect(refusalText("exhausted")).toBe("This request reached its 24 bot turn limit. Finish with what you have; the user can send a message to continue.");
  expect(refusalText("reserved")).toBe("This request's remaining bot turns are reserved. Collect pending replies before asking again.");
  expect(refusalText("missing")).toBe("This request's bot turn budget is no longer available. Finish with what you have; the user can send a message to continue.");
});

it("posts a UI-only row once per key and thread", () => {
  postCommsNotice(store, "paused", `root-${key}`, [bot.threadId, bot.threadId, peer.threadId]);
  postCommsNotice(store, "paused", `root-${key}`, [bot.threadId, peer.threadId]);
  for (const threadId of [bot.threadId, peer.threadId]) {
    const rows = lines(threadId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: "bot", kind: "activity", tool: { name: PAUSED } });
    expect(rows[0]!.tool).toEqual({ name: PAUSED });
    expect(rows[0]).not.toHaveProperty("comm");
  }
});

it("does not repeat a line already shown since the user's last message, even after a restart", () => {
  postCommsNotice(store, "unavailable", `missing-${key}`, [bot.threadId]);
  postCommsNotice(store, "unavailable", `other-${key}`, [bot.threadId]);
  expect(lines(bot.threadId).map((row) => row.tool?.name)).toEqual([UNAVAILABLE]);
  store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "keep going" });
  postCommsNotice(store, "unavailable", `next-${key}`, [bot.threadId]);
  expect(lines(bot.threadId)).toHaveLength(2);
});

it("posts to the thread where the human typed and the pair channel, and only its own thread without a root", () => {
  const home = bot.threadId;
  const rootId = rootForStart(home, { kind: "human", messageKey: `send-${key}` })!;
  const side = store.createTask(bot.id, "Side task", false)!.threadId;
  postRefusalNotice(store, "exhausted", rootId, "receipt", side, peer.threadId);
  expect(lines(home).map((row) => row.tool?.name)).toEqual([PAUSED]);
  expect(lines(peer.threadId).map((row) => row.tool?.name)).toEqual([PAUSED]);
  expect(lines(side)).toEqual([]);
  postRefusalNotice(store, "reserved", rootId, "receipt", home, peer.threadId);
  postRefusalNotice(store, "missing", null, `detached-${key}`, side);
  expect(lines(side).map((row) => row.tool?.name)).toEqual([UNAVAILABLE]);
  expect(lines(home)).toHaveLength(1);
  expect(lines(peer.threadId)).toHaveLength(1);
});

it("never writes account identity into a notice", () => {
  const email = "fake-account@example.invalid";
  const rootId = rootForStart(bot.threadId, { kind: "human", messageKey: email })!;
  postRefusalNotice(store, "exhausted", rootId, email, bot.threadId, peer.threadId);
  postRefusalNotice(store, "missing", undefined, email, bot.threadId);
  for (const threadId of [bot.threadId, peer.threadId]) expect(JSON.stringify(store.messagesFor(threadId))).not.toContain(email);
  expect((["exhausted", "reserved", "missing"] as const).map(refusalText).join(" ")).not.toContain(email);
});

it("posts a later request's pause in the pair channel after the user continued in their own chat", () => {
  vi.useFakeTimers({ now: 1_000_000 });
  const first = rootForStart(bot.threadId, { kind: "human", messageKey: `send-${key}` })!;
  postRefusalNotice(store, "exhausted", first, "receipt", bot.threadId, peer.threadId);
  vi.setSystemTime(1_060_000);
  store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "keep going" });
  const next = rootForStart(bot.threadId, { kind: "human", messageKey: `send-${key}-2` })!;
  postRefusalNotice(store, "exhausted", next, "receipt", bot.threadId, peer.threadId);
  postRefusalNotice(store, "exhausted", next, "receipt", bot.threadId, peer.threadId);
  expect(lines(bot.threadId)).toHaveLength(2);
  expect(lines(peer.threadId)).toHaveLength(2);
});

it("keeps nothing per root in memory, so expired roots leave nothing behind", () => {
  const source = readFileSync(new URL("./comms-notice.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(/^const \w+ = new (Set|Map)\b/m);
});
