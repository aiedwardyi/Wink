// Spoken consent, shared by the live call and the Mac call. Only a clear yes counts:
// a sentence that merely contains "sure" is a reply, not consent.

const YES_WORDS_EN = "yes|yeah|yep|yup|sure|ok|okay|alright|all right|no problem|no worries|go ahead|go for it|do it|do that|let'?s do it|sounds good|absolutely|of course|allow|approve|approved|fine|please do|send it|confirm|confirmed";
const YES_EN = new RegExp(`^(${YES_WORDS_EN})\\b`, "i");
const YES_LEAD_EN = new RegExp(`^(${YES_WORDS_EN}|go|right|correct|please|uh-huh|mm-hmm|thanks|thank you)\\b[\\s,.!]*`, "i");
// Only a yes on their own: "Right now?" and "Please make it blue" are not.
const YES_ALONE_EN = /^(right|correct|please|uh-huh|mm-hmm|go)[.!]*$/i;
// "Yes, don't send it", "Yes, but make it blue", or the voice's own offer echoed back: keeps waiting.
const BUT_EN = /\b(no|not|don'?t|do not|wait|hold on|stop|cancel|later|but|want me to|shall i|should i)\b/i;
const BUT_KO = /말고|근데|그런데|하지만|대신|잠깐|기다려/;
const FILLER = /^(uh|um|er|hmm|mm)\b(?!-)[\s,.]*/i;
const NO_EN = /^(no(?! problem| worries)|nope|don'?t|do not|stop|deny|denied|cancel|never|skip it)\b/i;
// 됐어 and 괜찮아 can mean either, and 잠깐 is a hold, so they keep waiting.
// 어 is a yes only with a yes after it, or alone: "어..." trails off.
export const YES_KO = ["응", "응응", "네", "넵", "예", "그래", "좋아", "맞아", "해", "해줘", "보내", "보내줘", "고고", "ㅇㅇ", "네네", "오케이", "해봐", "진행해", "진행해줘", "부탁해", "부탁드려", "부탁드립니다"];
export const NO_KO = ["아니", "아냐", "하지마", "취소"];
// Short 응 often transcribes as 은 or 음, so these count as the second word too.
const STRONG_YES_KO = ["보내", "보내줘", "해줘", "고고"];

// The call's other languages: a line of only these words, polite ones aside, is a yes or a no.
const YES_OTHER = [
  "sí", "si", "claro", "vale", "dale", "de acuerdo", "por supuesto",
  "oui", "ouais", "d'accord", "vas-y", "allez-y", "bien sûr",
  "ja", "jawohl", "klar", "genau", "gerne", "einverstanden",
  "sim", "pode", "beleza", "tá bom", "com certeza",
  "sì", "certo", "va bene", "d'accordo", "vai",
  "vâng", "dạ", "có", "được", "ừ",
  "да", "конечно", "хорошо", "давай", "ладно",
  "हाँ", "हां", "जी", "ठीक है", "बिल्कुल",
  "نعم", "أيوه", "ايوه", "حسنا", "حسناً", "تمام", "موافق",
  "はい", "ええ", "うん", "いいよ", "いいです", "お願いします", "お願い", "どうぞ",
  "好", "好的", "是", "是的", "对", "行", "可以", "嗯", "没问题",
  "ใช่", "ได้", "ตกลง", "โอเค", "เอา", "เอาเลย", "ครับ", "ค่ะ",
];
const NO_OTHER = ["non", "nein", "não", "không", "thôi", "нет", "не надо", "नहीं", "मत", "لا", "いいえ", "いや", "だめ", "やめて", "不", "不要", "不用", "不用了", "不行", "不好", "别", "算了", "ไม่", "ไม่เอา", "ไม่ใช่", "ไม่ต้อง", "ยกเลิก"];
const SOFT_OTHER = ["por favor", "gracias", "merci", "s'il te plaît", "s'il vous plaît", "bitte", "danke", "obrigado", "obrigada", "per favore", "grazie", "ạ", "nhé", "пожалуйста", "спасибо", "जी", "شكرا", "من فضلك", "です", "ね", "よ", "吧", "啊", "呀", "了", "请", "ครับ", "ค่ะ", "คะ", "นะ", "จ้ะ"];
const OTHER_WORDS = [...new Set([...YES_OTHER, ...NO_OTHER, ...SOFT_OTHER])].sort((a, b) => b.length - a.length);
// Thai, Japanese and Chinese words run on with no space after them.
const UNSPACED = /[฀-๿぀-ヿ一-鿿]$/u;

function otherConsent(said: string): "yes" | "no" | null {
  let rest = said.normalize("NFC").toLowerCase().replace(/’/g, "'").replace(/[\s,.!~…。、，！।]+/gu, " ").trim();
  const words: string[] = [];
  while (rest) {
    const word = OTHER_WORDS.find((known) => rest.startsWith(known) && (UNSPACED.test(known) || rest.length === known.length || rest[known.length] === " "));
    if (!word) return null;
    words.push(word);
    rest = rest.slice(word.length).trimStart();
  }
  const only = (kinds: string[][]) => words.every((word) => kinds.some((kind) => kind.includes(word)));
  if (words.some((word) => NO_OTHER.includes(word))) return only([NO_OTHER, SOFT_OTHER]) ? "no" : null;
  return words.some((word) => YES_OTHER.includes(word)) && only([YES_OTHER, SOFT_OTHER]) ? "yes" : null;
}

function koWords(text: string): string[] {
  return text.replace(/하지\s+마/g, "하지마").split(/[\s,.!?~…]+/).filter(Boolean).slice(0, 2)
    .map((word) => word.replace(/주세요$/, "줘").replace(/습니다$/, "아"))
    .map((word) => word.length > 1 ? word.replace(/요$/, "") : word);
}

export function consentOf(said: string): "yes" | "no" | null {
  const text = said.trim().replace(FILLER, "");
  const [first = "", second = ""] = koWords(text);
  // "아니면 내일 해줘" offers another way: neither a no nor a yes.
  if (/^아니(?:면|라)/.test(first)) return null;
  if (NO_EN.test(text) || [first, second].some((word) => NO_KO.some((no) => word.startsWith(no)))) return "no";
  // "Confirm?" asks, it does not answer.
  if (/[?？؟]\s*$/.test(text)) return null;
  if (YES_ALONE_EN.test(text)) return "yes";
  if (YES_EN.test(text)) return BUT_EN.test(text.replace(YES_EN, "")) ? null : "yes";
  if (BUT_KO.test(text)) return null;
  if (first === "어") return second ? (consentOf(text.replace(/^어[\s,.!?~…]*/, "")) === "yes" ? "yes" : null) : (!/\.\.|…/.test(text) ? "yes" : null);
  if (YES_KO.includes(first) || STRONG_YES_KO.includes(second)) return "yes";
  return otherConsent(text);
}

/** What follows the yes words: "Okay, delete the logs" leaves "delete the logs". */
export function afterYes(said: string): string {
  let rest = said.trim().replace(FILLER, "");
  while (YES_LEAD_EN.test(rest)) rest = rest.replace(YES_LEAD_EN, "");
  return rest;
}

/** A yes and nothing more: "Okay, delete the logs" asks, it does not answer. */
export function bareYes(said: string): boolean {
  if (consentOf(said) !== "yes") return false;
  if (otherConsent(said) === "yes") return true;
  return afterYes(said).split(/[\s,.!~…]+/).filter(Boolean).every((word) => ["어", "은", "음", ...YES_KO].includes(koWords(word)[0]!));
}

const DONE_EN = /\b(it'?s|is|all|i'?m|i'?ve|we'?re) (done|finished|fixed|complete|merged|pushed|live)\b/i;
const DONE_KO = /(완료(했|됐)|끝났|다 했|고쳤|수정했|보냈|머지했|푸시했)/;

/** The voice claims finished work. */
export function claimsDone(said: string): boolean {
  return DONE_EN.test(said) || DONE_KO.test(said);
}
