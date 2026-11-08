// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";

// each import of a fresh module copy stands in for one page load
const page = async () => {
  vi.resetModules();
  return import("./drafts");
};

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const sent = (drafts: Awaited<ReturnType<typeof page>>, over = {}) => ({
  draftId: "bot:b1:t1",
  revision: drafts.draftRevision("bot:b1:t1"),
  attachments: [],
  sendId: "send-1",
  text: "hello",
  requestText: "hello",
  threadId: "t1",
  after: true,
  ...over,
});

it("brings a failed send back after a reload with its sendId", async () => {
  const before = await page();
  expect(before.recoverFailedComposerSend(sent(before))).toBe("outbox");
  const after = await page();
  expect(after.failedComposerSends("bot:b1:t1")).toMatchObject([{ sendId: "send-1", text: "hello", threadId: "t1", after: true }]);
});

it("drops a row from storage on retry or dismiss", async () => {
  const before = await page();
  before.recoverFailedComposerSend(sent(before));
  before.recoverFailedComposerSend(sent(before, { sendId: "send-2" }));
  const [first, second] = before.failedComposerSends("bot:b1:t1");
  before.forgetFailedComposerSend("bot:b1:t1", first.id);
  expect((await page()).failedComposerSends("bot:b1:t1").map((s) => s.sendId)).toEqual(["send-2"]);
  before.forgetFailedComposerSend("bot:b1:t1", second.id);
  expect((await page()).failedComposerSends("bot:b1:t1")).toEqual([]);
});

it("keeps sending when storage throws", async () => {
  const boom = () => {
    throw new Error("blocked");
  };
  vi.stubGlobal("localStorage", { getItem: boom, setItem: boom });
  const drafts = await page();
  expect(drafts.recoverFailedComposerSend(sent(drafts))).toBe("outbox");
  const [failed] = drafts.failedComposerSends("bot:b1:t1");
  expect(failed.sendId).toBe("send-1");
  drafts.forgetFailedComposerSend("bot:b1:t1", failed.id);
  expect(drafts.failedComposerSends("bot:b1:t1")).toEqual([]);
});
