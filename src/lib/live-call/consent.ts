// Spoken consent, shared by the live call and the Mac call. Only a clear yes counts:
// a sentence that merely contains "sure" is a reply, not consent.

const YES_EN = /^(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|allow|approve|approved|fine|please do)\b/i;
const NO_EN = /^(no|nope|don'?t|do not|stop|deny|denied|cancel|never|skip it)\b/i;
// 됐어 and 괜찮아 can mean either, so they keep waiting.
export const YES_KO = ["응", "어", "네", "넵", "예", "그래", "좋아", "해", "해줘", "보내", "보내줘", "고고", "ㅇㅇ", "네네"];
export const NO_KO = ["아니", "아냐", "하지마", "취소", "잠깐"];
// Short 응 often transcribes as 은 or 음, so these count as the second word too.
const STRONG_YES_KO = ["보내", "보내줘", "해줘", "고고"];

function koWords(text: string): string[] {
  return text.replace(/하지\s+마/g, "하지마").split(/[\s,.!?~…]+/).filter(Boolean).slice(0, 2)
    .map((word) => word.length > 1 ? word.replace(/요$/, "") : word);
}

export function consentOf(said: string): "yes" | "no" | null {
  const text = said.trim();
  const [first = "", second = ""] = koWords(text);
  if (NO_EN.test(text) || [first, second].some((word) => NO_KO.some((no) => word.startsWith(no)))) return "no";
  if (YES_EN.test(text) || YES_KO.includes(first) || STRONG_YES_KO.includes(second)) return "yes";
  return null;
}

const DONE_EN = /\b(it'?s|is|all|i'?m|i'?ve|we'?re) (done|finished|fixed|complete|merged|pushed|live)\b/i;
const DONE_KO = /(완료(했|됐)|끝났|다 했|고쳤|수정했|보냈|머지했|푸시했)/;

/** The voice claims finished work. */
export function claimsDone(said: string): boolean {
  return DONE_EN.test(said) || DONE_KO.test(said);
}
