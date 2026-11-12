// Spoken consent, shared by the live call and the Mac call. Only a clear yes counts:
// a sentence that merely contains "sure" is a reply, not consent.

const YES_WORDS_EN = "yes|yeah|yep|yup|sure|ok|okay|alright|all right|go ahead|go for it|do it|let'?s do it|sounds good|absolutely|of course|allow|approve|approved|fine|please do|send it|confirm|confirmed";
const YES_EN = new RegExp(`^(${YES_WORDS_EN})\\b`, "i");
const YES_LEAD_EN = new RegExp(`^(${YES_WORDS_EN}|right|correct|please|uh-huh|mm-hmm|thanks|thank you)\\b[\\s,.!]*`, "i");
// Only a yes on their own: "Right now?" and "Please make it blue" are not.
const YES_ALONE_EN = /^(right|correct|please|uh-huh|mm-hmm)[.!]*$/i;
// "Yes, don't send it", "Yes, but make it blue", or the voice's own offer echoed back: keeps waiting.
const BUT_EN = /\b(no|not|don'?t|do not|wait|hold on|stop|cancel|later|but|want me to|shall i|should i)\b/i;
const BUT_KO = /말고|근데|그런데|하지만|대신/;
const FILLER = /^(uh|um|er|hmm|mm)\b(?!-)[\s,.]*/i;
const NO_EN = /^(no|nope|don'?t|do not|stop|deny|denied|cancel|never|skip it)\b/i;
// 됐어 and 괜찮아 can mean either, so they keep waiting.
// 어 is a yes only with a yes after it, or alone: "어..." trails off.
export const YES_KO = ["응", "응응", "네", "넵", "예", "그래", "좋아", "맞아", "해", "해줘", "보내", "보내줘", "고고", "ㅇㅇ", "네네", "오케이", "진행해", "진행해줘", "부탁해", "부탁드려", "부탁드립니다"];
export const NO_KO = ["아니", "아냐", "하지마", "취소", "잠깐"];
// Short 응 often transcribes as 은 or 음, so these count as the second word too.
const STRONG_YES_KO = ["보내", "보내줘", "해줘", "고고"];

function koWords(text: string): string[] {
  return text.replace(/하지\s+마/g, "하지마").split(/[\s,.!?~…]+/).filter(Boolean).slice(0, 2)
    .map((word) => word.replace(/주세요$/, "줘").replace(/습니다$/, "아"))
    .map((word) => word.length > 1 ? word.replace(/요$/, "") : word);
}

export function consentOf(said: string): "yes" | "no" | null {
  const text = said.trim().replace(FILLER, "");
  const [first = "", second = ""] = koWords(text);
  if (NO_EN.test(text) || [first, second].some((word) => NO_KO.some((no) => word.startsWith(no)))) return "no";
  // "Confirm?" asks, it does not answer.
  if (/\?\s*$/.test(text)) return null;
  if (YES_ALONE_EN.test(text)) return "yes";
  if (YES_EN.test(text)) return BUT_EN.test(text) ? null : "yes";
  if (BUT_KO.test(text)) return null;
  if (first === "어") return YES_KO.includes(second) || (!second && !/\.\.|…/.test(text)) ? "yes" : null;
  if (YES_KO.includes(first) || STRONG_YES_KO.includes(second)) return "yes";
  return null;
}

/** A yes and nothing more: "Okay, delete the logs" asks, it does not answer. */
export function bareYes(said: string): boolean {
  if (consentOf(said) !== "yes") return false;
  let rest = said.trim().replace(FILLER, "");
  while (YES_LEAD_EN.test(rest)) rest = rest.replace(YES_LEAD_EN, "");
  return rest.split(/[\s,.!~…]+/).filter(Boolean).every((word) => ["어", "은", "음", ...YES_KO].includes(koWords(word)[0]!));
}

const DONE_EN = /\b(it'?s|is|all|i'?m|i'?ve|we'?re) (done|finished|fixed|complete|merged|pushed|live)\b/i;
const DONE_KO = /(완료(했|됐)|끝났|다 했|고쳤|수정했|보냈|머지했|푸시했)/;

/** The voice claims finished work. */
export function claimsDone(said: string): boolean {
  return DONE_EN.test(said) || DONE_KO.test(said);
}
