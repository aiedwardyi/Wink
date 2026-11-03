import { describe, expect, it } from "vitest";

import { conversationPreview, roomConversationPreview } from "./conversation-preview";
import { t, translate, type Translate } from "./i18n";
import type { Message } from "@/state/store";

const from = { botId: "skye", name: "Skye", color: "blue" } as const;
const reply: Message = { id: "r", role: "bot", kind: "text", text: "Report is ready.", at: 1, from };
const card = { title: "Choose a route", subtitle: "", options: ["Left", "Right"], requestId: "request", tool: "Bash" };
const ko: Translate = (key, vars) => translate("ko", key, vars);

describe("room previews share message handling with bot previews", () => {
  const previews: Array<{ name: string; message: Message; expected: string; showTools?: boolean; translate?: Translate }> = [
    { name: "options", message: { id: "c", role: "bot", kind: "options", card, at: 2, from }, expected: "Choose a route" },
    { name: "settled approval", message: { id: "c", role: "bot", kind: "options", card: { ...card, requestId: "request", tool: "Bash", answered: "allow" }, at: 2, from }, expected: "Allowed" },
    { name: "screen", message: { id: "s", role: "bot", kind: "screen", at: 2, from }, expected: "Screen frame", showTools: true },
    { name: "note", message: { id: "n", role: "bot", kind: "note", text: "[pane abcdef12] [BUILD] from Wink (bot): FAIL BUILD branch=fix/build sha=123 dirty=no\nThe build broke.", at: 2, from }, expected: "Failed: The build broke." },
    { name: "Korean note", message: { id: "n", role: "bot", kind: "note", text: "[pane abcdef12] FAIL BUILD branch=fix/build sha=123 dirty=no\nThe build broke.", at: 2, from }, expected: "실패: The build broke.", translate: ko },
    { name: "launch", message: { id: "l", role: "bot", kind: "launch", text: "Launched BUILD\nWorking folder: C:/repo", at: 2, from }, expected: "Launched BUILD" },
  ];
  it.each(previews)("previews $name with the speaker", ({ message, expected, showTools = false, translate = t }) => {
    expect(roomConversationPreview({ messages: [message] }, [], showTools, translate)).toBe(translate("chrome.speakerPrefix", { name: "Skye", text: expected }));
    expect(conversationPreview({ messages: [message], activeLeafId: message.id }, translate, showTools)).toBe(expected);
  });

  const empty: Array<{ name: string; message: Message }> = [
    { name: "image-only user message", message: { id: "i", role: "user", kind: "text", text: '<attached-image path="C:/image.png"/>', at: 2 } },
    { name: "empty bot message", message: { id: "e", role: "bot", kind: "text", at: 2, from } },
    { name: "ignored onboarding card", message: { id: "c", role: "bot", kind: "options", at: 2, from, card: { title: "What do you mostly want help with?", subtitle: "", options: ["Work & projects", "Writing & research", "Life admin", "A bit of everything"], dismissed: true } } },
  ];
  it.each(empty)("skips $name before adding a speaker prefix", ({ message }) => {
    expect(roomConversationPreview({ messages: [reply, message] })).toBe("Skye: Report is ready.");
    expect(roomConversationPreview({ messages: [message] })).toBe("No messages yet");
  });
});
