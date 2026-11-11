import { describe, expect, it } from "vitest";

import { claimsDone, consentOf } from "./consent";

describe("consentOf", () => {
  it.each([
    "yes", "Yes. Send it.", "yeah go", "ok", "go ahead", "do it",
    "응", "응, 보내.", "어", "네", "네, 보내주세요", "넵", "예", "그래", "좋아요", "해", "해줘", "보내", "고고", "ㅇㅇ",
    "은 보내줘.", "음 보내",
    "Alright.", "Sounds good.", "Let's do it.", "Go for it.", "Absolutely.", "Of course.", "Uh, yes.", "Um, okay.", "오케이", "진행해 주세요", "부탁해",
  ])("%s is yes", (said) => expect(consentOf(said)).toBe("yes"));

  it.each([
    "no", "No, wait", "don't", "stop", "cancel that",
    "아니", "아니요", "아냐", "하지 마", "하지마", "취소", "취소해", "잠깐만요", "아니 보내", "응 아니",
  ])("%s is no", (said) => expect(consentOf(said)).toBe("no"));

  it.each([
    "됐어", "괜찮아", "어떻게 해?", "어떻게 하지", "네가 해야 하는 거 아니야", "I'm sure it works", "what about the tests", "",
    "Yes, don't send it.", "Sure, but wait.", "Of course not.", "Absolutely not.", "Sounds good, but not now.", "Alright, hold on.",
  ])("%s keeps waiting", (said) => expect(consentOf(said)).toBeNull());
});

describe("claimsDone", () => {
  it.each(["It's done.", "All fixed!", "I've pushed it", "we're live", "완료했어요", "다 끝났어요", "버그 고쳤어요", "머지했습니다", "보냈어요"])("%s claims done", (said) => {
    expect(claimsDone(said)).toBe(true);
  });

  it.each(["I'll send it now.", "Shall I send that?", "보낼게요", "고쳐 드릴까요?", "It is not done yet"])("%s does not", (said) => {
    expect(claimsDone(said)).toBe(false);
  });
});
