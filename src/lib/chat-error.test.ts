// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { applyLocale, translate, type Translate } from "./i18n";
import { ErrorRow } from "../components/ChatView";
import { RoomToolChip } from "../components/GroupView";
import { localizeServerLine } from "./activity-runs";

const en: Translate = (key, vars) => translate("en", key, vars);
const ko: Translate = (key, vars) => translate("ko", key, vars);

vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("../state/store")>(),
  useStore: () => ({ state: { bots: [{ id: "atlas", name: "Atlas" }], instances: [] }, dispatch: vi.fn() }),
}));

describe("chat errors", () => {
  it("localizes API credit promo failures without raw details", async () => {
    const { chatErrorText } = await import("./error-text");
    for (const line of ["codex_byok_restricted_by_api_credit_promo", "This OpenAI key's org is on API credit, which Codex can't use. Pick another Codex account."]) {
      expect(chatErrorText(`error: ${line}`, "Wink", en)).toEqual({ text: "This OpenAI key's org is on API credit, which Codex can't use. Pick another Codex account.", raw: undefined });
      expect(chatErrorText(`error: ${line}`, "Wink", ko)).toEqual({ text: "이 OpenAI 키의 조직은 API 크레딧 프로모션을 사용 중이라 Codex를 쓸 수 없어요. 다른 Codex 계정을 선택하세요.", raw: undefined });
    }
  });

  it("localizes a send refused for a signed-out account", async () => {
    const { classifyChatError } = await import("../../shared/chat-error");
    const { chatBannerError } = await import("./error-text");
    const line = "This account is signed out. Sign in again, then send your message.";
    expect(classifyChatError(line)).toEqual({ kind: "known", key: "errors.signedOut" });
    try {
      applyLocale("ko");
      expect(chatBannerError(new Error(line))).toBe("로그아웃됐어요. 다시 로그인한 뒤 보내세요.");
    } finally {
      applyLocale("en");
    }
  });

  it("says in both languages when the engine or the sign-in ended a reply nobody stopped", async () => {
    const { chatBannerError } = await import("./error-text");
    try {
      expect(chatBannerError(new Error("Grok stopped this reply on its own"))).toBe("Grok stopped this reply on its own. Send your message again.");
      expect(chatBannerError(new Error("the sign-in changed while the reply was starting"))).toBe("The sign-in changed while the reply was starting. Send your message again.");
      applyLocale("ko");
      expect(chatBannerError(new Error("Grok stopped this reply on its own"))).toBe("Grok에서 답변을 스스로 멈췄어요. 메시지를 다시 보내 주세요.");
      expect(chatBannerError(new Error("the sign-in changed while the reply was starting"))).toBe("답변을 시작하는 동안 로그인이 바뀌었어요. 메시지를 다시 보내 주세요.");
    } finally {
      applyLocale("en");
    }
  });

  it("names a failed Grok hook in both languages with its reason under Details", () => {
    const line = "Grok hook failed (재판기록_대화기록): ~/scoop/python.exe: can't open file 'G:/대화기록_게이트.py'";
    for (const [locale, expected] of [
      ["en", "Grok blocked this message: a hook on this PC failed (재판기록_대화기록). Fix or remove the hook, then resend."],
      ["ko", "이 PC의 Grok 훅이 실패해서 메시지가 막혔습니다 (재판기록_대화기록). 훅을 고치거나 지운 뒤 다시 보내세요."],
    ] as const) {
      applyLocale(locale);
      try {
        const html = renderToStaticMarkup(createElement(ErrorRow, { message: line, botId: "atlas", botName: "Atlas", onRetry: () => {} }));
        expect(html).toContain(expected);
        expect(html).toMatch(/<details[^>]*><summary[^>]*>[^<]+<\/summary><div[^>]*>~\/scoop\/python\.exe: can&#x27;t open file &#x27;G:\/대화기록_게이트\.py&#x27;<\/div><\/details>/);
      } finally {
        applyLocale("en");
      }
    }
  });

  it("keeps an unknown engine cancel category under Details", () => {
    const html = renderToStaticMarkup(createElement(ErrorRow, { message: "Grok stopped this reply on its own (QuotaGuard)", botId: "atlas", botName: "Atlas" }));
    expect(html).toContain("Grok stopped this reply on its own. Send your message again.");
    expect(html).toMatch(/<details[^>]*>.*QuotaGuard.*<\/details>/);
  });

  it.each(["bot", "channel"])("shows a %s send task switch as a known failure in 1:1 and rooms", async (target) => {
    const { classifyChatError } = await import("../../shared/chat-error");
    const line = `the ${target} switched tasks before it could receive the message`;
    expect(classifyChatError(line)).toEqual({ kind: "known", key: "errors.sendTaskChanged" });
    for (const [locale, expected] of [
      ["en", "Not sent. The chat moved to another task. Send your message again."],
      ["ko", "전송되지 않았어요. 채팅이 다른 작업으로 바뀌었어요. 메시지를 다시 보내 주세요."],
    ] as const) {
      applyLocale(locale);
      try {
        const direct = renderToStaticMarkup(createElement(ErrorRow, { message: line, botId: "atlas", botName: "Atlas" }));
        const room = renderToStaticMarkup(createElement(RoomToolChip, {
          message: { id: "task-switch", at: 1, role: "bot", kind: "activity", from: { botId: "atlas", name: "Atlas", color: "blue" }, tool: { name: `error: ${line}`, ok: false } },
        }));
        expect(direct).toContain(expected);
        expect(room).toBe(direct);
        expect(direct).not.toContain("<details");
      } finally {
        applyLocale("en");
      }
    }
  });

  it.each([
    "a turn is already running on this thread",
    "turn cancelled before dispatch",
    "queued message could not start - the bot is still stopping its last turn - try again in a moment",
    "queued room turn could not start - no such task",
  ])("keeps internal guards out of red rows: %s", (message) => {
    expect(renderToStaticMarkup(createElement(ErrorRow, { message, botId: "atlas", botName: "Atlas" }))).toBe("");
  });

  it("translates known failures in both languages", async () => {
    const { chatErrorText } = await import("./error-text");
    expect(chatErrorText("no activity for 20 minutes - the turn was stopped", "Atlas", en))
      .toEqual({ text: "No reply for 20 minutes. The turn was stopped." });
    expect(chatErrorText("no activity for 20 minutes - the turn was stopped", "Atlas", ko))
      .toEqual({ text: "20분 동안 응답이 없어 작업을 멈췄어요." });
    expect(localizeServerLine("error: no working engine supports this bot's current tools", ko)).toContain("설정");
  });

  it("puts an unknown raw line only inside closed details and keeps Retry", () => {
    const html = renderToStaticMarkup(createElement(ErrorRow, {
      message: "unrecognised driver failure: private stack fragment",
      botId: "atlas", botName: "Atlas", onRetry: () => {},
    }));
    expect(html).toContain("Atlas couldn&#x27;t finish that.");
    expect(html).toContain("Retry");
    expect(html).toMatch(/<details[^>]*><summary[^>]*>Details<\/summary><div[^>]*>unrecognised driver failure: private stack fragment<\/div><\/details>/);
    expect(html).not.toContain("<details open");
  });

  it("does not hide unavailable models in the queued-error class", async () => {
    const { classifyChatError } = await import("../../shared/chat-error");
    expect(classifyChatError('queued message could not start - provider instance "gone" is unavailable - pick another model in settings')).toMatchObject({ kind: "known", key: "errors.model" });
  });

  it("renders a room failure exactly like a 1:1 failure", () => {
    const message = "unrecognised driver failure";
    const direct = renderToStaticMarkup(createElement(ErrorRow, { message, botId: "atlas", botName: "Atlas", onRetry: () => {} }));
    const room = renderToStaticMarkup(createElement(RoomToolChip, {
      message: { id: "row", at: 1, role: "bot", kind: "activity", from: { botId: "atlas", name: "Atlas", color: "blue" }, tool: { name: `error: ${message}`, ok: false } },
      onRetry: () => {},
    }));
    expect(room).toBe(direct);
    expect(room).not.toContain("error:");
    expect(room).not.toContain("font-mono");
  });

  it("only quiets the two internal usage refresh choices", async () => {
    const { quietUsageError } = await import("../../shared/chat-error");
    expect(quietUsageError("Usage refresh is not supported")).toBe(true);
    expect(quietUsageError("Claude refresh skipped to avoid Keychain prompts on macOS")).toBe(true);
    expect(quietUsageError("Sign in again in Claude")).toBe(false);
  });

  it("keeps existing setup instructions when the engine card is unavailable", () => {
    const html = renderToStaticMarkup(createElement(ErrorRow, { message: "Claude is not signed in.", botId: "atlas" }));
    expect(html).toContain("Claude is not signed in.");
    expect(html).not.toContain("<details");
  });
});
