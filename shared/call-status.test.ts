import { describe, expect, it } from "vitest";

import { callStatus, capBytes, firstNeed, STATUS_MAX_BYTES, workerReports } from "./call-status.ts";

const CALL = { id: "c-0123456789ab" };
const user = (id: string, text: string, extra: object = {}) => ({ id, role: "user", kind: "text", text, ...extra });
const note = (id: string, pane: string, report: string) => ({ id, role: "user", kind: "note", text: `[pane ${pane}] [${report.split(" ")[1]} | opus | high] from Nova (b1): ${report} branch=x sha=1 dirty=0\nlong body` });
const card = (id: string, subtitle: string, options: string[]) => ({ id, role: "bot", kind: "options", card: { title: "Your bot has a question", subtitle, options, askUser: true as const } });
const bytes = (text: string) => new TextEncoder().encode(text).length;

describe("call STATUS", () => {
  it("says idle, or busy with the last thing the person sent, skipping call lines and peers", () => {
    const rows = [user("u1", "Fix the login page."), user("v1", "Can you hear me?", { call: CALL }), user("p1", "Peer note.", { from: { botId: "b2" } })];
    expect(callStatus("Nova", false, rows)).toBe("Nova is idle.");
    expect(callStatus("Nova", true, rows)).toBe("Nova is busy, working on: Fix the login page.");
  });

  it("lists the open question with its options until it is answered", () => {
    const rows = [card("q1", "Restart at 8:15 PM instead?", ["Yes, 8:15 PM", "Still 1 AM"])];
    expect(callStatus("Nova", false, rows)).toBe("Nova is idle.\nOpen question for the person: Restart at 8:15 PM instead? Options: Yes, 8:15 PM; Still 1 AM.");
    expect(callStatus("Nova", false, [...rows, user("a", "8:15.", { call: { ...CALL, ask: true } })])).toBe("Nova is idle.");
  });

  it("keeps the newest report per worker, newest first, five at most, without bodies", () => {
    const rows = [
      note("n1", "aaaaaaaa", "FAIL BUILD"),
      ...["A", "B", "C", "D", "E"].map((nick, i) => note(`m${i}`, "bbbbbbbb", `DONE ${nick}`)),
      note("n2", "aaaaaaaa", "BLOCKED BUILD"),
      note("n3", "aaaaaaaa", "DONE BUILD"),
    ];
    expect(workerReports(rows)).toEqual(["BUILD reported DONE", "E reported DONE", "D reported DONE", "C reported DONE", "B reported DONE"]);
    expect(callStatus("Nova", false, rows)).not.toContain("long body");
    expect(workerReports([note("n1", "aaaaaaaa", "FAIL BUILD")])).toEqual(["BUILD reported FAILED"]);
  });

  it.each([["en", "Restart the whole eval loop and check every shard. "], ["ko", "평가 루프를 다시 시작하고 모든 샤드를 확인해 주세요. "]])("stays under 1.6 KB on a whole line, never splitting a character (%s)", (_lang, chunk) => {
    const rows = [
      user("u1", chunk.repeat(40)),
      card("q1", chunk.repeat(40), Array.from({ length: 30 }, (_, i) => `${chunk.repeat(2)}${i}`)),
      ...Array.from({ length: 8 }, (_, i) => note(`n${i}`, `0000000${i}`, `DONE ${"긴작업".repeat(10)}${i}`)),
    ];
    const status = callStatus("Nova", true, rows);
    expect(bytes(status)).toBeLessThanOrEqual(STATUS_MAX_BYTES);
    expect(status).not.toContain("�");
    expect(status.startsWith("Nova is busy")).toBe(true);
  });

  it("cuts bytes safely inside Hangul when there is no line break", () => {
    const cut = capBytes("가".repeat(100), 10);
    expect(cut).toBe("가가가");
  });
});

describe("firstNeed", () => {
  it("says an approval's title and subtitle, and a key card's label, never the call's own key card", () => {
    expect(firstNeed([{ id: "a1", role: "bot", kind: "options", card: { title: "Run a command?", subtitle: "git push origin main", options: [], requestId: "r1", tool: "Bash" } }]))
      .toEqual({ id: "a1", short: "Run a command?: git push origin main" });
    expect(firstNeed([{ id: "a2", role: "bot", kind: "options", card: { title: "", subtitle: "", options: [], requestId: "r2", tool: "Bash" } }])).toEqual({ id: "a2", short: "Bash" });
    expect(firstNeed([{ id: "k0", role: "bot", kind: "secret", secret: { label: "Gemini key", requestKey: "call-1" } }, { id: "k1", role: "bot", kind: "secret", secret: { label: "GitHub token", requestKey: "gh" } }]))
      .toEqual({ id: "k1", short: "GitHub token" });
  });
});
