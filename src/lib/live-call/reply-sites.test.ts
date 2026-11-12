import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store-types";
import { isVoiceLine } from "../../../shared/live-call";
import { timelineEvents } from "../taskTimeline";
import { logLine } from "../terminal-skin";
import { streamResetFor } from "../turn-stage";
import { showWorkingDots } from "../turn-tail";
import { unreadReplyCount } from "../unread";

const voice = { id: "v", role: "bot", kind: "text", text: "Sure, sending it.", at: 2, call: { id: "c-0123456789ab", voice: true } } as Message;
const reply = { id: "r", role: "bot", kind: "text", text: "Fixed.", at: 3 } as Message;
const order = { id: "o", role: "user", kind: "text", text: "Fix it.", at: 1, call: { id: "c-0123456789ab", order: true } } as Message;

describe("isVoiceLine at reply sites", () => {
  it("tells call lines from orders and plain rows", () => {
    expect(isVoiceLine(voice)).toBe(true);
    expect(isVoiceLine({ call: { id: "c-0123456789ab" } })).toBe(true);
    expect(isVoiceLine(order)).toBe(false);
    expect(isVoiceLine({ call: { id: "c-0123456789ab", ask: true } })).toBe(false);
    expect(isVoiceLine(reply)).toBe(false);
  });

  it("never resets the bot's stream", () => {
    expect(streamResetFor(voice)).toBeNull();
    expect(streamResetFor(reply)).toBe("stream");
  });

  it("keeps the working dots under a voice line", () => {
    expect(showWorkingDots(true, undefined, voice)).toBe(true);
    expect(showWorkingDots(true, undefined, reply)).toBe(false);
  });

  it("does not count voice lines as unread replies", () => {
    expect(unreadReplyCount(true, 0, [order, voice, voice, reply])).toBe(1);
  });

  it("does not record a voice line as the response", () => {
    expect(timelineEvents([voice]).some((event) => event.kind === "result")).toBe(false);
    expect(timelineEvents([reply]).some((event) => event.kind === "result")).toBe(true);
  });

  it("does not log a voice line as the bot's info line", () => {
    expect(logLine(true, 0, [voice])["data-log-level"]).toBeUndefined();
    expect(logLine(true, 0, [reply])["data-log-level"]).toBe("info");
  });
});
