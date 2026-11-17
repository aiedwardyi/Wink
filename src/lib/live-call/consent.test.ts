import { describe, expect, it } from "vitest";

import { bareYes, claimsDone, consentOf } from "./consent";

describe("consentOf", () => {
  it.each(["Do that", "Thank you. Do that.", "yes do it", "go ahead", "please", "응", "해줘", "그래"])("confirms the pending note with %s", (said) => {
    expect(consentOf(said)).toBe("yes");
    expect(bareYes(said)).toBe(true);
  });

  it.each(["Thanks, um, yes", "Thank you, uh, okay."])("confirms past a filler after the thanks: %s", (said) => {
    expect(consentOf(said)).toBe("yes");
    expect(bareYes(said)).toBe(true);
  });

  it("confirms a thanked yes in another language", () => expect(bareYes("Thanks, Sí.")).toBe(true));

  it.each(["Thank you.", "Thanks, but wait.", "Thanks, yes, 잠깐만.", "yes, 잠깐만", "Thank you. Do not do that.", "Thanks. Do that?", "Thank you. Please make it blue."])("does not confirm with %s", (said) => {
    expect(consentOf(said)).not.toBe("yes");
  });

  it.each([
    "yes", "Yes. Send it.", "yeah go", "ok", "go ahead", "do it",
    "응", "응, 보내.", "어", "네", "네, 보내주세요", "넵", "예", "그래", "좋아요", "해", "해줘", "보내", "고고", "ㅇㅇ",
    "은 보내줘.", "음 보내",
    "Alright.", "Sounds good.", "Let's do it.", "Go for it.", "Absolutely.", "Of course.", "Uh, yes.", "Um, okay.", "오케이", "진행해 주세요", "부탁해",
    "해주세요", "그렇게 해주세요", "진행해주세요", "보내주세요", "좋습니다", "부탁드립니다", "부탁드려요", "맞아요", "응응", "어 그래",
    "Send it", "Send it.", "Right.", "Correct.", "Confirm.", "Uh-huh.", "Mm-hmm", "Please.",
  ])("%s is yes", (said) => expect(consentOf(said)).toBe("yes"));

  it.each([
    "no", "No, wait", "don't", "stop", "cancel that",
    "아니", "아니요", "아냐", "하지 마", "하지마", "취소", "취소해", "아니 보내", "응 아니",
  ])("%s is no", (said) => expect(consentOf(said)).toBe("no"));

  it.each([
    "됐어", "괜찮아", "어떻게 해?", "어떻게 하지", "네가 해야 하는 거 아니야", "I'm sure it works", "what about the tests", "",
    "Yes, don't send it.", "Sure, but wait.", "Of course not.", "Absolutely not.", "Sounds good, but not now.", "Alright, hold on.",
    "어...", "어 그거 말고 다른 거", "네 근데 그거 말고요", "응 그런데 하나만", "Yes, but make it blue", "Okay want me to open your desktop folder",
    "Right now?", "Please make it blue.", "Confirm?", "Yes?",
  ])("%s keeps waiting", (said) => expect(consentOf(said)).toBeNull());
});

describe("consentOf in the call's other languages", () => {
  it.each([
    "Sí.", "Sí, por favor.", "Claro.", "De acuerdo.", "Oui.", "Oui, merci.", "D'accord.", "Ja.", "Ja, bitte.", "Klar.", "Sim.", "Pode.", "Sì.", "Va bene.", "Vâng.", "Dạ vâng.", "Được.",
    "Да.", "Да, пожалуйста.", "Хорошо.", "हाँ।", "हाँ जी", "ठीक है", "نعم.", "نعم، من فضلك.", "تمام", "はい。", "はい、お願いします。", "うん", "好的。", "好", "是的", "可以", "ใช่ครับ", "ได้ค่ะ", "ตกลง",
  ])("%s is yes", (said) => expect(consentOf(said)).toBe("yes"));

  it.each([
    "Non.", "Non, merci.", "Nein.", "Nein, danke.", "Não.", "Không.", "Нет.", "Нет, спасибо.", "नहीं।", "لا.", "لا، شكرا.", "いいえ。", "いや", "だめ", "不要。", "不用了", "不好", "算了", "ไม่ครับ", "ไม่เอา", "ไม่ต้องค่ะ",
  ])("%s is no", (said) => expect(consentOf(said)).toBe("no"));

  it.each([
    "Sí, pero mañana.", "Oui, mais attends.", "Ja, aber später.", "はい、でも明日。", "好的，但是等一下。", "ใช่ แต่รอก่อน", "Да, но потом.", "はい？", "好吗？", "Claro que no.",
  ])("%s keeps waiting", (said) => expect(consentOf(said)).toBeNull());

  it.each(["はい", "好的", "ใช่ครับ", "Sí.", "Oui", "Да."])("%s is a bare yes", (said) => expect(bareYes(said)).toBe(true));
});

describe("claimsDone", () => {
  it.each(["It's done.", "All fixed!", "I've pushed it", "we're live", "완료했어요", "다 끝났어요", "버그 고쳤어요", "머지했습니다", "보냈어요"])("%s claims done", (said) => {
    expect(claimsDone(said)).toBe(true);
  });

  it.each(["I'll send it now.", "Shall I send that?", "보낼게요", "고쳐 드릴까요?", "It is not done yet"])("%s does not", (said) => {
    expect(claimsDone(said)).toBe(false);
  });
});

describe("O11 consent says what he meant", () => {
  it.each(["Do that.", "Go.", "해봐", "어 그렇게 해줘", "No problem, go ahead.", "No worries, send it."])("%s is yes", (said) => expect(consentOf(said)).toBe("yes"));
  it.each(["잠깐만", "잠깐만요", "아니면 내일 해줘", "Go to the settings page."])("%s keeps waiting", (said) => expect(consentOf(said)).toBeNull());
});

describe("review: holds and alternatives never confirm", () => {
  it.each(["응, 잠깐만.", "네, 잠깐만요.", "아니면 해줘.", "어! 어, 잠깐"])("%s keeps waiting", (said) => expect(consentOf(said)).toBeNull());
  it.each(["어, 어, 보내줘.", "어… 어, 보내줘!"])("%s is yes", (said) => expect(consentOf(said)).toBe("yes"));
  it("Go. is a bare yes", () => expect(bareYes("Go.")).toBe(true));
});
