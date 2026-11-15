// What the voice's turn claims, one sentence at a time: a promise of work, a refusal, a dodge, or an honest "not sent".
import { bareYes } from "./consent";

export type Claim = "promise" | "cant" | "unsure" | "failed";

const ACTION_EN = /\b(?:(?:i'?ll|i will|i am going to|i'?m going to|let me|let's|i'?m|i am|i'?ve|i have|i just|i already)\s+(?:certainly\s+|just\s+|now\s+|already\s+|go ahead and\s+)?(?:check|checking|checked|look|looking|looked|find|finding|found|ask|asking|asked|open|opening|opened|add|adding|added|send|sending|sent|start|starting|started|get started|handle|handling|fix|fixing|fixed|schedule|scheduled|restart|restarting|run|running|ran|take care|go ahead|proceed|work on|working on|merge|merging|merged|deploy|deploying|deployed|push|pushing|pushed|delete|deleting|deleted|remove|removing|removed|install|installing|installed|create|creating|created|update|updating|updated|commit|committing|committed|close|closing|closed|move|moving|moved|rename|renaming|renamed)|i (?:checked|looked|found|asked|opened|added|sent|started|fixed|scheduled|restarted|ran|merged|deployed|pushed|deleted|removed|installed|created|updated|committed|closed|moved|renamed))\b(?!\s+(?:late|behind|out|low|back)\b)/i;
// "Opening it now.": the same promise with its subject dropped.
const DOING_EN = /^(?:(?:okay|ok|sure|got it|alright|right|yes|yep|yeah)[,!.]?\s+)?(?:now\s+)?(?:checking|looking|opening|adding|sending|starting|fixing|restarting|running|merging|deploying|pushing|deleting|removing|installing|creating|updating|committing|closing|moving|renaming)\s+(?:it|that|this|them|those|the|your|my|a|an|up|into|now|right)\b/i;
// "Running the tests will show you": a gerund as a verb's subject explains; "Opening it so you can see" still promises.
const EXPLAINS = "will|would|can|could|should|may|might|is|are|was|were|lets|helps|shows|gives|makes|means|takes|tells|works|saves";
const SUBJECTS = "you|it|we|they|i|he|she|that|this|which";
const EXPLAINED = new RegExp(`(?<!\\b(?:${SUBJECTS})\\s)\\b(?:${EXPLAINS})\\b`, "i");
const ON_IT = /^(?:(?:okay|ok|sure|got it|alright|right)[,!.]?\s+)?(?:i'?m\s+)?on it\b/i;
const ACTION_KO = /확인해\s?(?:볼게|보겠|드릴게|드리겠)|확인했|알아\s?(?:볼게|보겠)|알아봤|찾아\s?(?:볼게|보겠)|찾았|열어\s?(?:볼게|드릴게|드리겠)|열었|추가했|추가해\s?(?:둘게|드릴게|놓을게)|바로\s?(?:확인|진행|처리)|진행할게|진행하겠|처리할게|처리하겠|보내\s?드릴게|보냈|물어\s?(?:볼게|보겠)|(?:확인|추가|시작|수정|예약|재시작|실행|머지|병합|배포|푸시|삭제|설치|업데이트|커밋|검색)\s?(?:할게|하겠|해\s?(?:볼게|둘게|놓을게|드릴게|보겠|드리겠))|(?:열|고칠|보낼|지울|만들|닫을|옮길|바꿀|돌릴|찾을|올릴)게|(?:고쳐|보내|지워|만들어|닫아|옮겨|바꿔|돌려|올려)\s?(?:볼게|둘게|놓을게|드릴게|줄게|보겠|드리겠)|(?:그렇게|바로|지금|당장)\s?(?:할게|하겠)/;
const CANT = /\b(?:i can(?:not|'?t)|i'?m unable|i am unable|unable to|i (?:don'?t|do not) have access|no access)\b[^.!?]*\b(?:open|access|see|check|find|look|do|interact|reach|read|run)\b|(?:열|볼|접근할|확인할|찾을|실행할|읽을|들어갈) 수(?:가)? 없|권한이 없/i;
const UNSURE = /\b(?:not (?:entirely |quite |really |completely )?sure|i (?:don'?t|do not) know|i (?:don'?t|do not) (?:report|provide|track)|i (?:don'?t|do not) have (?:that |this |any |the )?(?:info|information|data|details|access))\b|잘 모르|모르겠|알 수 없|정보가 없/i;
// An offer, question or condition promises nothing yet.
const HYPOTHETICAL = /\?\s*$|\b(?:if you|let me know|whenever|once you|when you|would you like|do you want|want me to|shall i|should i)\b|시면|으면|할까요|드릴까요|볼까요/i;
const CLARIFY = /\b(?:heard|hear you|catch that|repeat|say that again|what you mean)\b|다시 말씀|다시 한 ?번|못 들었|잘 안 들/i;
// What a recap reports as done; only what is left after it can still be a promise.
const DONE = /\bi(?:'?ve| have| just| already)?\s+(?:just\s+|already\s+)?(?:checked|looked|found|asked|opened|added|sent|started|fixed|scheduled|restarted|ran|merged|deployed|pushed|deleted|removed|installed|created|updated|committed|closed|moved|renamed)\b|확인했|알아봤|찾았|열었|추가했|보냈/gi;
const FAILED = /\b(?:nothing (?:was|has been|got) sent|(?:wasn'?t|was not|isn'?t|is not|hasn'?t been|has not been|couldn'?t be|could not be) sent|not sent|nothing is running)\b|아무것도 (?:안 )?보내지 않|보내지 (?:않았|못했)|안 보냈|전송되지 않/i;

// A thinking noise is not an answer, so it promises nothing.
const FILLER_ONLY = /^(?:uh|um|er|hmm+|mm+|ah|oh|음+|어+|아+)[\s.,!…]*$/i;

const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);

/** The first claim in a turn; an honest "not sent" anywhere wins, and a clarification is never a dodge. With an unsent order, any plain answer is a promise unless it ends asking back. */
export function claimOf(said: string, recap = false, order = false): { claim: Claim; sentence: string } | null {
  if (FAILED.test(said)) return { claim: "failed", sentence: said };
  const clarifies = CLARIFY.test(said);
  let plain = "";
  for (const sentence of sentences(said)) {
    if (HYPOTHETICAL.test(sentence)) continue;
    const ahead = recap ? sentence.replace(DONE, " ") : sentence;
    if (ACTION_EN.test(ahead) || (DOING_EN.test(ahead) && !EXPLAINED.test(ahead)) || ON_IT.test(ahead) || ACTION_KO.test(ahead)) return { claim: "promise", sentence };
    if (CANT.test(sentence)) return { claim: "cant", sentence };
    if (!clarifies && UNSURE.test(sentence)) return { claim: "unsure", sentence };
    if (!FILLER_ONLY.test(sentence)) plain ||= sentence;
  }
  return order && plain && !clarifies && !/\?\s*$/.test(said) ? { claim: "promise", sentence: plain } : null;
}

const CHANGES = "open|run|restart|reboot|fix|send|add|delete|remove|schedule|install|deploy|push|merge|create|write|edit|change|move|close|kill|stop|start|update|rename|commit";
// A bare "Stop.", "Start over.", "Change to Korean." or "Update me." mostly talks to the voice itself.
const OPENERS = "open|run|restart|reboot|fix|send|add|delete|remove|schedule|install|deploy|push|merge|create|write|edit|move|close|kill|rename|commit";
const CHANGE_EN = new RegExp(`\\b(?:can|could|would|will) you (?:please )?(?:just )?(?:${CHANGES})\\b|^\\s*(?:please\\s+)?(?:${OPENERS})\\b`, "i");
const CHANGE_KO = /(?:열어|실행해|재시작해|재부팅해|고쳐|수정해|보내|추가해|삭제해|지워|예약해|설치해|배포해|푸시해|머지해|만들어|바꿔|옮겨|닫아|꺼|시작해|켜)\s?(?:줄|줘|주세요|주실|줄래|주시겠)/;

/** A request to change something, even phrased as a question: it needs propose_work and a yes. */
export function asksForChange(question: string): boolean {
  return CHANGE_EN.test(question) || CHANGE_KO.test(question);
}

const LEAD_EN = "hey|hi|hello|ok(?:ay)?|so|and|now|well|alright|yeah|yes|please|just|then|also|go ahead and";
const NEED_EN = new RegExp(`\\b(?:i (?:need|want|would like|'d like) you to|you (?:need|have) to) (?:please )?(?:just )?(?:${CHANGES})\\b`, "i");
// The plain form ends the line: "고쳐도 돼?" asks. No 보내, 꺼 or 켜: "좋은 하루 보내" and "내 꺼" are talk.
const COMMAND_KO = /(?:열어|실행해|재시작해|재부팅해|고쳐|수정해|추가해|삭제해|지워|예약해|설치해|배포해|푸시해|머지해|커밋해|만들어|바꿔|옮겨|닫아|업데이트해)\s?(?:봐|라|요)?[\s.!~…]*$/;

/** His line as an order in the shapes speech takes: behind a hello, a name or a softener, as "I need you to", or a plain Korean command. */
export function ordersChange(heard: string, names: readonly string[] = []): boolean {
  const lead = [LEAD_EN, ...names.map(escaped).filter(Boolean)].join("|");
  const said = heard.replace(new RegExp(`^\\s*(?:(?:${lead})(?![\\p{L}\\p{N}])[\\s,.!]*)+`, "iu"), "");
  return asksForChange(said) || NEED_EN.test(heard) || COMMAND_KO.test(heard);
}

const LOOKUP_EN = /^\s*(?:please\s+)?(?:search|look\s+(?:up|into)|look\s+(?:it|that|this|him|her|them)\s+up|google|research|find\s+out)\b/i;
// Korean puts the verb last, so the lookup has to end the order: "검색해서 나온 파일은 지워줘" deletes.
const LOOKUP_KO = /(?:(?:검색|조사)(?:\s?좀)?\s?해|(?:찾아|알아)\s?(?:봐|보세요|볼래|줘|주세요|줄래))(?:\s?(?:봐|보세요|볼래|줘|주세요|줄래))*요?[\s.!?~]*$/;
// A second step: a list mark, a new sentence (an initial like "E." is not one), a 고 clause, a joining word or a change word.
const STEPS = "and|then|before|after|while|until|once";
const MORE = new RegExp(`[;,:]|(?<!(?<![\\p{L}\\p{N}])\\p{L})[.!?]\\s+\\S|[가-힣]고\\s|\\b(?:${STEPS}|${CHANGES})\\b`, "iu");

/** A plain lookup changes nothing, so it needs no yes; a second step makes it an order. */
export function looksUp(order: string): boolean {
  return (LOOKUP_EN.test(order) || LOOKUP_KO.test(order)) && !MORE.test(order) && !CHANGE_KO.test(order);
}

// What a lookup wraps around the question it repeats.
const LOOKUP_WORDS = new Set("please search look up into google research find out for about on if whether 검색해줘 검색해 검색해주세요 찾아봐 찾아줘 알아봐 알아봐줘 좀 대해".split(" "));

/** A question already asked, said again in other words: every word of it is in the order, and the order adds only lookup words. */
export function restates(order: string, asked: Iterable<string>): boolean {
  const words = order.split(" ");
  const have = new Set(words);
  return [...asked].some((was) => {
    const known = new Set(was.split(" "));
    return [...known].every((word) => have.has(word)) && words.every((word) => known.has(word) || LOOKUP_WORDS.has(word));
  });
}

const RECAP = /^\s*(?:(?:so|and|okay|ok|hey)[,\s]+)?(?:did|have|has|had)\s+(?:you|we|they|it|he|she)\b|\bwhat\b[^.!?]*\b(?:did|have|has|had|got|was|were)\b|\b(?:recap|so far|summary|summarize)\b|뭐 했|한 일|했어\s*\??\s*$|했나요|했니|됐어\s*\?|됐나요/i;

/** A question about work already done, so its answer recounts the past. */
export function asksAboutDone(request: string): boolean {
  return RECAP.test(request);
}

const WORK = /\b(?:status|updates?|progress|news|done|finish(?:ed)?|ready|repl(?:y|ied)|answer(?:ed)?|working|running)\b|\bhow(?:'s| is| are| did)\b[^.!?]*\b(?:going|go|look(?:ing)?|doing)\b|\b(?:did|has|have|is|are) (?:it|that|the|my|our)\b|상태|진행|끝났|다 됐|어떻게 (?:됐|돼|되)|하고 있|소식|결과|답(?:장|변)|뭐래/i;

/** A question about the bot or its work, so a reply the voice had not seen may have changed the answer. */
export function asksAboutWork(heard: string, name = ""): boolean {
  return asksAboutDone(heard) || WORK.test(heard) || Boolean(name.trim()) && heard.toLowerCase().includes(name.trim().toLowerCase());
}

const AGAIN = /\bwhat(?:'s| is| was)\s+(?:the|that|their|his|her|its)\s+question\b|\bwhat (?:did|does) (?:\w+ )?(?:ask|want)\b|\b(?:say|read) (?:that|it|the question) again\b|\brepeat (?:that|it|the question)\b|\bcome again\b|^\s*(?:sorry|pardon|what|huh)\s*[?!.]*\s*$|질문이?\s*뭐|뭐라고|뭘 물어|뭐 물어|다시 (?:말해|말씀|읽어|한 ?번)|못 들었/i;

/** The person asking to hear the question again, which is not its answer. */
export function asksToRepeat(heard: string): boolean {
  return AGAIN.test(heard);
}

// The whole line is the command, give or take a name, a softener or a polite ending: "영어로 말하지 마" and "stop talking about X" are not.
const QUIET_EN = /(?:be quiet|keep quiet|stay quiet|quiet down|quiet|silence|stop talking|shut up|hush|shh+|zip it|(?:that'?s )?enough|no more (?:updates|talking))/.source;
const QUIET_KO = /(?:조용(?:해|히(?:\s?좀)?(?:\s?(?:해|하세요|있어))?)?|(?:말\s?)?그만(?:\s?(?:해|하세요|말해(?:도\s?(?:돼|되))?))?|말하지\s?마|닥쳐|쉿|시끄러(?:워)?|입\s?다물어)\s?(?:요|줘|봐|라|세요|주세요|줄래)?/.source;
const SOFT = /please|just|ok(?:ay)?|now|wait|hold on|hey|(?:can|could|would|will) you|좀|이제|그만|잠깐(?:만)?|헤이/.source;
const FOR_A_BIT = /for (?:a|one) (?:second|sec|minute|min|moment|bit|while)/.source;

const escaped = (name: string) => name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// How speech-to-text spells a shown voice name. A whole word only: "Jenkins" and "에디터" are not names.
const SPELLED: Record<string, string> = { Jenn: "Jen|젠|제니퍼", Eddie: "Eddy|에디" };
const spelled = (aliases: readonly string[]) => aliases.flatMap((alias) => SPELLED[alias] ? [`(?:${SPELLED[alias]})(?:야|아)?(?![a-z0-9가-힣])`] : []);

/** The person telling the voice to stop talking for now, which is not a no to a job. */
export function asksForQuiet(heard: string, name = "", aliases: readonly string[] = []): boolean {
  // The shown name may run on: "Jenn" is called "Jennifer" too.
  const own = [escaped(name), ...aliases.map((alias) => `${escaped(alias)}[a-z]*`), ...spelled(aliases)].filter(Boolean).join("|");
  const lead = `(?:(?:${SOFT}${own && `|(?:${own})(?:야|아)?`})[\\s,]*)*`;
  const tail = `(?:[\\s,]+(?:please|now|for now|${FOR_A_BIT}${own && `|${own}`}))*`;
  return new RegExp(`^${lead}(?:${QUIET_EN}${tail}|${QUIET_KO})[\\s~….,!?]*$`, "i").test(heard.trim());
}

/** Talking to the voice again: its name, the name the picker shows for its voice, or a "hey". */
export function callsVoice(heard: string, name: string, aliases: readonly string[] = []): boolean {
  // Whole name only, though a Korean particle may follow it ("Nova야"); the shown name may run on ("Jennifer").
  const own = [escaped(name) && `${escaped(name)}(?![a-z0-9])`, ...aliases.map((alias) => `${escaped(alias)}[a-z]*(?![0-9])`), ...spelled(aliases)].filter(Boolean).join("|");
  return /\bhey\b|헤이/i.test(heard) || (own !== "" && new RegExp(`(?<![\\p{L}\\p{N}])(?:${own})`, "iu").test(heard));
}

// Letters English and Korean never use, and the words a mis-hear lands on ("¿Qué?", "Hola, aquí estoy.").
const FOREIGN_SCRIPT = /[¿¡ñЀ-ۿऀ-๿぀-ヿ一-鿿]/iu;
const FOREIGN_WORDS = /(?<![\p{L}\p{N}])(?:hola|aquí|estoy|gracias|qué|cómo|está|estás|bueno|claro|perdón|bonjour|merci|oui|danke|hallo|obrigado|olá|ciao|grazie)(?![\p{L}\p{N}])/giu;
const HANGUL = /[가-힣]/;

/** Speech in a third language. The brief keeps the voice to the app's; English and Korean lines are never cut here, he may mix them. */
export function offLanguage(text: string): boolean {
  if (FOREIGN_SCRIPT.test(text)) return true;
  // Capitalized mid-sentence it is a name, like the Bonjour service; "Hola" opening a line is Spanish.
  return [...text.matchAll(FOREIGN_WORDS)].some((word) => !/^\p{Lu}/u.test(word[0]) || !/\p{L}[^.!?]*$/u.test(text.slice(0, word.index)));
}

/** A line speech-to-text likely got wrong: another language, or a word or two that trail off with no end mark. Korean transcripts often have none. */
export function misheard(text: string): boolean {
  if (offLanguage(text)) return true;
  if (HANGUL.test(text) || bareYes(text) || ordersChange(text)) return false;
  return !/[.!?…]["'”’)\]]*\s*$/.test(text) && (text.match(/\p{L}[\p{L}'’-]*/gu)?.length ?? 0) <= 2;
}

const ASK_LEAD = /^(?:(?:so|and|sorry|okay|ok|just|but)[,\s]+)?(?:could|can|would|will|which|what|where|when|who|whose|how|do|does|did|are|is|was|should|shall)\b/i;
const FILLER_WORDS = new Set("the and you your for with that this what which want mean kind could would should about have does did are was were can will just like some any one from into let check checking look looking find finding ask asking now right whether there here sure okay".split(" "));
const contentWords = (text: string) => text.toLowerCase().match(/\p{L}{3,}|\p{N}+/gu)?.filter((word) => !FILLER_WORDS.has(word)) ?? [];
const sameWord = (a: string, b: string) => a === b || (a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5));
/** Most of the line's words are in one of the others. */
const covered = (line: string, others: readonly string[]) => {
  const words = contentWords(line);
  return words.length > 0 && others.some((other) => {
    const known = contentWords(other);
    // "60 seconds" is not "30 seconds", however many other words match.
    if (words.some((word) => /\p{N}/u.test(word) && !known.includes(word))) return false;
    const shared = words.filter((word) => known.some((was) => sameWord(word, was))).length;
    return shared >= Math.min(2, words.length) && shared / words.length >= 0.5;
  });
};

/** Whether the voice's turn opens by asking again what it already asked; "wait" until its first question is whole. */
export function reasks(said: string, asked: readonly string[], whole = false): "yes" | "no" | "wait" {
  const first = sentences(said)[0] ?? "";
  if (!first) return whole ? "no" : "wait";
  if (!ASK_LEAD.test(first) && !first.includes("?")) return "no";
  if (!whole && !/[.!?…]\s*$/.test(first)) return "wait";
  return covered(first, asked) ? "yes" : "no";
}

/** A promise the questions sent this turn stand behind: "Let me check whether you finished it", not "your watch history". */
export function backs(promise: string, sent: readonly string[]): boolean {
  return !contentWords(promise).length || covered(promise, sent);
}

const tokens = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];

/** The voice's own words back through a phone speaker: his line is a run of them. Under three words it may be either. */
export function echoOf(heard: string, voice: string): "echo" | "maybe" | "no" {
  const words = tokens(heard);
  const said = tokens(voice);
  if (!words.length) return "maybe";
  if (!said.some((_, start) => words.every((word, i) => said[start + i] === word))) return "no";
  return words.length >= 3 ? "echo" : "maybe";
}

/** "Hmm.", "Yes.": a nod while the voice talks, not a barge-in. */
export function backchannel(heard: string): boolean {
  return /^(?:h?m+|mhm|uh-?huh|u[hm]+|yeah|yes|yep|ok|okay|right|응|네|어)[.!?,\s]*$/i.test(heard.trim());
}

/** The bot's reply asks again what its card asks. */
export function repeatsAsk(reply: string, question: string): boolean {
  return sentences(reply).some((sentence) => covered(sentence, [question]));
}
