import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LANE_HANDOFF_LINE, laneHandoff, laneHandoffNote } from "./room-lane.ts";
import { _resetSteerQueue, drainSteeredMessages, queueRoomParticipation, type SteerStore } from "./steer-queue.ts";
import type { BotRecord, Message } from "./store.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const section = (from: string, to: string) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  if (start < 0 || end < start) throw new Error(`Missing section: ${from}`);
  return source.slice(start, end);
};

const row = (message: Partial<Message>): Message => ({ id: `m${Math.random()}`, at: 0, role: "user", kind: "text", ...message } as Message);
const asked = [row({ text: "fix the header", id: "ask" })];
const turn = { lane: true, hop: 0, teammate: false, autoApprove: false, rows: asked, botId: "pip", owner: "Edward" };

describe("lane hand-off", () => {
  it("hands a person's room ask on the lane to a full turn, named by asker", () => {
    expect(laneHandoff(turn)).toEqual({ asker: "Edward", ask: "fix the header" });
    expect(laneHandoff({ ...turn, rows: [row({ text: "fix it", author: { kind: "person", id: "p1", name: "Mina" } as Message["author"] })] })?.asker).toBe("Mina");
  });

  it("hands nothing off from an ordinary room turn, a bot's chain or a bot's line", () => {
    expect(laneHandoff({ ...turn, lane: false })).toBeNull();
    expect(laneHandoff({ ...turn, hop: 1 })).toBeNull();
    expect(laneHandoff({ ...turn, rows: [...asked, row({ role: "bot", text: "on it", from: { botId: "nova", name: "Nova", color: "blue" } })] })).toBeNull();
  });

  it("hands a teammate's ask off only under the host's Auto setting", () => {
    expect(laneHandoff({ ...turn, teammate: true, autoApprove: false })).toBeNull();
    expect(laneHandoff({ ...turn, teammate: true, autoApprove: true })).not.toBeNull();
  });

  it("frames the full turn as work asked in the room by its asker", () => {
    const note = laneHandoffNote("Launch", "Mina", "fix the header");
    expect(note).toContain('Mina asked you in "Launch": "fix the header"');
    expect(note).toContain("no_reply_needed");
  });

  it("puts the plain-words line only in a lane turn's room prompt", () => {
    const expression = section("  const roomSystem =", ";\n");
    const prompt = (handoff: object | null) => runInNewContext(`${expression}; roomSystem`, {
      handoff, LANE_HANDOFF_LINE, system: "SYS", cwd: "", workspace: undefined, cfg: {}, bot: { id: "pip" }, lane: Boolean(handoff), text: "", integrations: {}, selectedSkills: [],
      projectFolderPrompt: () => "", detailedRepliesEnabled: () => false, DETAILED_REPLY_INSTRUCTIONS: "", ALWAYS_REPLY_INSTRUCTIONS: "", DEFAULT_RULES: "",
      memorySystemPrompt: () => "", memoryNotesEnabled: () => true, renderSkillInstructions: () => "", installedPlaybookInstructions: () => "", harnessPlaybookPrompt: () => "",
    }) as string;
    expect(prompt({ asker: "Edward", ask: "fix it" })).toContain(LANE_HANDOFF_LINE);
    expect(prompt(null)).not.toContain(LANE_HANDOFF_LINE);
    expect(LANE_HANDOFF_LINE.length).toBeLessThan(125);
    expect(LANE_HANDOFF_LINE).not.toMatch(/1:1|read-only|lane|file|worker/i);
  });

  it("speaks of helpers, never workers, in the always-reply rules", () => {
    const constants = section("const ALWAYS_REPLY_FUNCTIONAL_INSTRUCTIONS =", "const CORPUS_SEARCH_INSTRUCTIONS =");
    const rules = runInNewContext(`${constants}ALWAYS_REPLY_INSTRUCTIONS`) as string;
    expect(rules).not.toMatch(/worker/i);
    expect(rules).toContain("(you, a helper, CI, the user)");
  });
});

function fakeBot(id: string, busy: boolean): BotRecord {
  return { id, threadId: `${id}-1to1`, name: id, title: "", description: "", notifications: false, color: "green", unread: false, modelSelection: { instanceId: "fake", model: "fake-model" }, resumeCursors: {}, busy, createdAt: 0 };
}
const fakeStore = (bots: BotRecord[]): SteerStore => ({
  bot: (id) => bots.find((bot) => bot.id === id) ?? null,
  messagesFor: () => [],
  appendMessage: (_threadId, message) => ({ id: "m", at: 0, ...message }),
  patchMessage: () => null,
});

describe("hand-off queue", () => {
  afterEach(() => _resetSteerQueue());

  it("waits for the bot to be free, never for a lane", () => {
    const pip = fakeBot("pip", true);
    queueRoomParticipation(pip.id, "room", { groupId: "g", cardContinuation: "note", hands: true });
    const run = vi.fn();
    drainSteeredMessages(fakeStore([pip]), run, undefined, () => true);
    expect(run).not.toHaveBeenCalled();
    pip.busy = false;
    drainSteeredMessages(fakeStore([pip]), run, undefined, () => true);
    expect(run.mock.calls[0][5]).toEqual({ groupId: "g", hop: 0, cardContinuation: "note", hands: true });
  });

  it("lets a plain room line take the lane while a hand-off waits", () => {
    const pip = fakeBot("pip", true);
    queueRoomParticipation(pip.id, "room", { groupId: "g", cardContinuation: "note", hands: true });
    queueRoomParticipation(pip.id, "room", { groupId: "g" });
    const run = vi.fn();
    drainSteeredMessages(fakeStore([pip]), run, undefined, () => true);
    expect(run.mock.calls.map((call) => call[5])).toEqual([{ groupId: "g", hop: 0 }]);
    pip.busy = false;
    drainSteeredMessages(fakeStore([pip]), run, undefined, () => true);
    expect(run.mock.calls[1][5]).toMatchObject({ hands: true, cardContinuation: "note" });
  });

  it("folds two hand-offs for one room into one turn carrying both notes", () => {
    const pip = fakeBot("pip", false);
    queueRoomParticipation(pip.id, "room", { groupId: "g", cardContinuation: "first", hands: true });
    queueRoomParticipation(pip.id, "room", { groupId: "g", cardContinuation: "second", hands: true });
    const run = vi.fn();
    drainSteeredMessages(fakeStore([pip]), run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][5].cardContinuation).toBe("first\n\nsecond");
  });
});
