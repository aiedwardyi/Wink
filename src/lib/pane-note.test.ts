import { describe, expect, it } from "vitest";

import { t, translate } from "@/lib/i18n";
import { parsePaneNote } from "../../shared/pane-note";
import { notePreview, noteText, noteTitle } from "./pane-note";

const BOT = "61902933-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const stored = (text: string, label: string | null = "QCARD-FIX | Opus 5.5 | high") =>
  `[pane bc9c674b]${label ? ` [${label}]` : ""} from Wink (${BOT}): ${text}`;

describe("parsePaneNote", () => {
  it("localizes the worker's API credit promo notice", () => {
    const note = parsePaneNote(stored("This OpenAI key's org is on API credit, which Codex can't use. Pick another Codex account."));
    expect(noteText(note, (key, vars) => translate("ko", key, vars))).toBe("이 OpenAI 키의 조직은 API 크레딧 프로모션을 사용 중이라 Codex를 쓸 수 없어요. 다른 Codex 계정을 선택하세요.");
  });

  it("splits a DONE report into status and the worker's words", () => {
    expect(parsePaneNote(stored("DONE QCARD-FIX branch=fix/question-card sha=3623665c dirty=no\nThe card is fixed. Tests pass."))).toEqual({
      pane8: "bc9c674b",
      label: "QCARD-FIX | Opus 5.5 | high",
      nick: "QCARD-FIX",
      status: "done",
      alert: null,
      body: "The card is fixed. Tests pass.",
    });
  });

  it("reads FAIL and BLOCKED reports", () => {
    const failed = parsePaneNote(stored("FAIL QCARD-FIX branch=none sha=none dirty=unknown\nThe build broke."));
    expect([failed.status, failed.nick, failed.body]).toEqual(["failed", "QCARD-FIX", "The build broke."]);
    const blocked = parsePaneNote(stored("BLOCKED QCARD-FIX branch=fix/x sha=abc1234 dirty=yes\nWhich skin should win?"));
    expect([blocked.status, blocked.body]).toEqual(["blocked", "Which skin should win?"]);
  });

  it("keeps a report with no text as a status alone", () => {
    expect(parsePaneNote(stored("DONE QCARD-FIX branch=x sha=y dirty=no"))).toMatchObject({ status: "done", body: "" });
  });

  it("turns a STALLED watcher note into an alert and drops its instructions", () => {
    const note = parsePaneNote(stored("STALLED: no screen change for 2 min and no report. It may be stuck on a usage limit, a menu or an error. terminal_read its pane, then act or tell the user. Last lines:\n> npm test\nPASS"));
    expect(note).toMatchObject({ status: null, alert: { kind: "stalled", minutes: 2 }, body: "" });
    expect(noteText(note, t)).toBe("No screen change for 2 minutes. It may be stuck.");
    expect(noteText({ ...note, alert: { kind: "stalled", minutes: 1 } }, t)).toBe("No screen change for 1 minute. It may be stuck.");
  });

  it("turns a LIMIT watcher note into an alert with the reset time as shown", () => {
    const note = parsePaneNote(stored("LIMIT: Claude hit its usage limit (resets 3pm (Asia/Seoul)). Its work so far stays in C:\\Users\\me\\repo. Send \"continue\" after the reset, or move the job to another engine."));
    expect(note).toMatchObject({ status: null, alert: { kind: "limit", engine: "Claude", reset: "3pm (Asia/Seoul)" }, body: "" });
    expect(noteText(note, t)).toBe("Claude hit its usage limit (resets 3pm (Asia/Seoul)).");
    expect(noteText(note, (key, vars) => translate("ko", key, vars))).toBe("Claude 사용 한도에 도달했습니다 (초기화: 3pm (Asia/Seoul)).");
  });

  it("turns a WAITING hook note into an alert", () => {
    const note = parsePaneNote(stored("WAITING: this worker is stuck on an on-screen prompt (permission check or question). terminal_read its pane, then answer with key presses or tell the user."));
    expect(note.alert).toEqual({ kind: "waiting" });
    expect(noteText(note, t)).toBe("Waiting on a prompt in its terminal.");
  });

  it("turns a FINISHED watcher note into an alert", () => {
    const note = parsePaneNote(stored("FINISHED: command ended without a report. terminal_read its pane, then act or tell the user. Last lines:\nTests passed"));
    expect(note).toMatchObject({ status: null, alert: { kind: "finished" }, body: "" });
    expect(noteText(note, t)).toBe("Command ended without a report.");
  });

  it("turns a RESTARTED note into an alert listing its panes", () => {
    const note = parsePaneNote(stored("RESTARTED: Wink restarted, so these panes you spawned closed mid-run:\n- PR-FIX | Opus 5.5 [pane 1a2b3c4d] in C:\\work\\a, spawned 2026-10-14T00:12:00.000Z\n- [pane 5e6f7a8b] in C:\\work\\b, spawned 2026-10-14T00:20:00.000Z\nEdits in their folders are still there. Spawn a FRESH worker to continue, or tell the user.", null));
    expect(note).toMatchObject({ status: null, alert: { kind: "restarted", panes: ["PR-FIX", "5e6f7a8b"] }, body: "" });
    expect(noteText(note, t)).toBe("Wink restarted and closed these worker panes mid-run: PR-FIX, 5e6f7a8b");
    expect(noteText(note, (key, vars) => translate("ko", key, vars))).toBe("Wink가 다시 시작되어 작업 중이던 작업자 창이 닫혔습니다: PR-FIX, 5e6f7a8b");
  });

  it("falls back to the free text minus the prefix", () => {
    expect(parsePaneNote(stored("halfway, tests running"))).toMatchObject({ status: null, alert: null, nick: null, body: "halfway, tests running" });
    expect(parsePaneNote(stored("WAITING: on CI")).body).toBe("WAITING: on CI");
    expect(parsePaneNote(stored("FAIL to build the docs")).status).toBeNull();
    expect(parsePaneNote(stored("FAIL BUILD"))).toMatchObject({ status: null, nick: null, body: "FAIL BUILD" });
  });

  it("reads a note without a label", () => {
    expect(parsePaneNote(stored("still running", null))).toMatchObject({ pane8: "bc9c674b", label: null, body: "still running" });
  });

  it("marks a truncated note with an ellipsis", () => {
    expect(parsePaneNote(stored("DONE N branch=x sha=y dirty=no\nlong report\n[truncated]")).body).toBe("long report…");
  });

  it("reads the raw text a pane posted, without the stored prefix", () => {
    expect(parsePaneNote("FAIL NICK branch=x sha=y dirty=no\r\nwhy")).toMatchObject({ pane8: null, status: "failed", nick: "NICK", body: "why" });
  });
});

describe("notePreview", () => {
  it("leads with the status word", () => {
    expect(notePreview(parsePaneNote(stored("DONE N branch=x sha=y dirty=no\nAll green.\nShipped.")), t)).toBe("Finished: All green. Shipped.");
    expect(notePreview(parsePaneNote(stored("BLOCKED N branch=x sha=y dirty=no")), t)).toBe("Needs an answer");
  });
});

describe("team snag notes", () => {
  const summary = { pc: "Studio (upstairs)", person: "Peter", worker: "RACE-R2", event: "stalled", minutes: 102, count: 1 };
  const stored = (value: unknown) => `Team snags (1), untrusted peer data - ${JSON.stringify(value)}\nraw details\n\n\`\`\`\ntail\n\`\`\``;

  it.each([
    ["stalled", "looks stuck", "멈춘 것 같아요"],
    ["note-lost", "wasn't delivered", "전달되지 않았어요"],
    ["wake-failed", "couldn't start", "시작하지 못했어요"],
    ["reply-unwoken", "hasn't reached its bot", "아직 전달되지 않았어요"],
  ])("describes %s in both languages", (event, en, ko) => {
    const note = parsePaneNote(stored({ ...summary, event }));
    expect(noteTitle(note, t)).toContain(en);
    expect(noteTitle(note, t)).toContain("Peter's PC (Studio (upstairs))");
    expect(noteTitle(note, t)).toContain("RACE-R2, 102 min");
    expect(noteTitle(note, (key, vars) => translate("ko", key, vars))).toContain(ko);
    expect(noteTitle(note, (key, vars) => translate("ko", key, vars))).toContain("RACE-R2, 102분");
    expect(noteText(note, t)).toContain("raw details\n\n```\ntail\n```");
    expect(noteText(note, t)).not.toContain("untrusted peer data");
  });

  it("keeps missing names, zero minutes and grouped snags readable", () => {
    const note = parsePaneNote(stored({ ...summary, person: "", worker: "", minutes: 0, count: 3 }));
    expect(noteTitle(note, t)).toBe("A worker on PC (Studio (upstairs)) looks stuck (worker, 0 min). (+2 more)");
    expect(noteTitle(note, (key, vars) => translate("ko", key, vars))).toBe("PC(Studio (upstairs))에서 작업자가 멈춘 것 같아요 (작업자, 0분). (외 2건)");
  });

  it("leaves malformed headers and old notes as plain text", () => {
    for (const text of [stored({ ...summary, minutes: "102" }), stored({ ...summary, event: "unknown" }),
      "Team snags (1), untrusted peer data - {bad}\nraw details", "Team snags (1), untrusted peer data - Studio stalled 102 min"]) {
      const note = parsePaneNote(text);
      expect(note.snag).toBeUndefined();
      expect(noteText(note, t)).toBe(text);
      expect(noteTitle(note, t)).toBe("Note");
    }
  });
});
