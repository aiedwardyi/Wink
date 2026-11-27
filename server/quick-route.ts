// Gate 1 of the quick router: a busy-time question goes to the quick helper first; any other message goes to the bot
// at once and the helper answers only the question in it, except approvals, refusals and pauses, which go to the bot alone.
const MAX_CHARS = 240;
const SENTENCE = /(?<=[.!?])\s+|\n+/;
const ATTACH_OR_LINK = /<attached-(image|file)|https?:\/\//i;
// Filler a sentence may open with, stripped before the checks ("okay great.", "hahaha", "wait", "btw").
const LEAD =
  /^((["'“”]+|(ok|okay|k|kk|yeah|yea|ya|true|great|cool|nice|perfect|awesome|got it|thanks|thx|ty|lol|lmao|haha\w*|wow|oh|ah|hmm+|hey|yo|wait|actually|but|and|also|then|plus|btw|so|anyway|afterwards|later|first|next|now|after that|maybe|please|pls|plz)\b)[\s,.!:]*)+/i;
// Approvals, refusals, pauses and suggestions steer the running work with no reply beside them, whatever follows.
const STEER =
  /^(yes|yep|yup|go|go ahead|go for it|do (it|that|this|both|all|them)|let'?s do|ship it|merge it|push it|lgtm|sounds good|sure|alright|dont|don't|do not|no|nope|never|stop|pause|hold on|cancel|instead|nvm|never ?mind|how about|what about|what if|why not|why don'?t (we|you|u))\b/i;
// One verb list for "fix it" and "can you fix it?", so the two forms never drift apart.
const ACT =
  "ship|merge|push|deploy|release|continue|resume|fix|add|make|build|change|update|remove|delete|rename|run|install|use|try|send|give|put|move|record|save|write|create|open|check|test|keep|start|restart|reinstall|set|turn|upload|download|buy|grab|park|skip|drop|revert|undo|approve|allow|deny|retry|redo|finish|wrap|close|launch|publish|post|get|switch|stop|look|find out|go|share|draft|retake|apply|commit|spawn|ask|squash|rebase|amend|cherry-pick|pick|choose|split|combine|rerun|refactor|tell (him|her|them|pokkey|wink|\\w+ bot)";
const COMMAND = new RegExp(`^(switched|done|let'?s|lets|please|pls|plz|${ACT})\\b`, "i");
// "can you <verb>" (also "do" and "mind", which open questions on their own), "can we <verb>" (not "when can we"), "please": asks the bot to act, even with a question mark.
const REQUEST = new RegExp(
  `\\b((can|could|would|will|wanna|want to)\\s+(u|you|ya)|(?<!\\b(when|what|how|why|where|which)\\s)(can|could|shall)\\s+we)\\s+(please\\s+|pls\\s+|also\\s+|just\\s+|quickly\\s+)?(${ACT}|do|mind)\\b|\\b(please|pls|plz|asap|let'?s|lets)\\b`,
  "i",
);
// Reports carry news the bot needs, even when they end with a question.
const REPORT =
  /\b(fyi|i'?m (done|back|bak)|im (done|back|bak)|it'?s (saved|done)|i (just )?(did|saved|installed|restarted|logged in|signed in|finished|pushed|merged|sent|uploaded|changed|set|added|removed|deleted|clicked|tried|ran)|bug|broken|does ?n'?o?t work|not working|stopped working|crash(es|ed)?|glitch)\b/i;
// A helper verb only asks when its subject follows: "could use more space" is feedback, "could it" asks.
const QUESTION_START =
  /^((quick q\b|q:|what|whats|what's|where|wheres|where's|which|who|whose|when|why|how|any|remind me|tell me|explain|u remember|you remember|r u)\b|(is|isn't|isnt|are|aren't|was|were|do|does|did|didn't|can|could|should|would|will|have|has|had)\s+(i|u|you|we|they|he|she|it|this|that|these|those|there|my|our|ur|your|the|a|an|any|anyone|everyone|everything|all)\b)/i;
// \b never matches inside Hangul, so a Korean word ends at a space, punctuation or the end.
const KO_LEAD = /^((지금|근데|그런데|그럼|그러면|그리고|그래서|혹시|아|어|음)[\s,.!~]+)+/;
// 됐어 and 맞아 approve; with a "?" they ask.
const KO_STEER = /^(아냐|아뇨|멈[춰추]|그만(?!큼)|잠깐|잠시만|기다려|취소|(아니[야요]?|응|네|넵|그래요?|좋아요?|(됐어|맞아)요?(?!\s*\?))(?=$|[\s,.!?~ㅋㅎㅠㅜ]))/;
const KO_REQUEST =
  /((줘|줄래|볼까|볼래|할까|할래)요?|하자)(?=$|[\s,.!?~ㅋㅎㅠㅜ])|주세요|주시|주실|줄 ?수 ?있|도 ?(돼|되|될)|어때|어떨까/;
// "not that" and "don't" anywhere refuse.
const KO_STOP = /(말고|지 ?마(요|라|세요)?)(?=$|[\s,.!?~ㅋㅎㅠㅜ])/;
const KO_REPORT = /버그|고장|크래시|안 ?(돼|되|됨)|같은데|[는은인]데[\s,]+\S/;
// 뭐든 and 왜냐하면 open statements.
const KO_QUESTION = /^(뭐|무엇|어디|언제|왜|어떻게|얼마|몇|누가|어느)(?!든|냐하?면)|(나요|까요|인가요?|일까)\?*$/;
// Greetings, pings and asks aimed at the helper itself: a sentence of only these words orders nothing.
const HELLO = /\b(hi+|hello+|hey+|yo+|sup|wh?at'?s ?up|wassup|howdy|ping|test(ing)?|sidekick|side ?bot)\b|안녕|하이|헬로|테스트|사이드킥|사이드 ?봇/i;
const CASUAL_WORD =
  "hi+|hello+|hey+|heya|hiya|yo+|sup|wh?at'?s ?up|wassup|howdy|ping|test(s|ing)?|\\d+|sidekick|side ?bot|helper|main|one|if|(you|u|ya)('?re|'?r| are| r)?|youre|ur|are|r|is|the|a|there|here|still|alive|awake|asleep|sleeping|i think|say|((do|dont|don'?t|do not) )?(respond|reply|answer)|let me know|with|sentence|last|time|again|please|pls|yeah|yea|ya|ok|okay|and|so|lol|lmao|ha(ha)+\\w*|" +
  "안녕(하세요)?|하이|헬로|ㅎㅇ|테스트(중)?|사이드킥(이면|이라면|이야)?|사이드 ?봇(이면|이라면|이야)?|거기|아직|있어(요)?|인사(해|해줘|해주세요)|대?답(해|해줘|해주세요)|ㅋ+|ㅎ+";
const CASUAL = new RegExp(`^((${CASUAL_WORD})(?=$|[\\s,.!?~])[\\s,.!?~]*)+$`, "i");
// A pick or a number answers the bot's question: "both", "squash both", "2", "the second one".
const PICK = /^((\w+ )?both|all( of (them|it))?|everything|neither|none|(the )?(first|second|third|fourth|last)( one| option)?|option [a-z0-9]|#?\d+)[\s.!]*$/i;
const KO_PICK = /^(둘 ?다|전부|모두|(첫|두|세|네) ?번째(꺼|것)?|\d+ ?번(째)?)[\s.!~]*$/;
// "what port is it, please?", "can it run on Windows, please?" and "could you explain why, please?" ask for facts; "switched to X" and "done" report news. Neither orders anything.
const INFO_Q =
  /^((what|whats|what's|where|wheres|where's|which|who|whose|when|why|how)\b|(is|isn't|isnt|are|aren't|arent|was|wasn't|wasnt|were|weren't|werent|am|does|doesn't|doesnt|did|didn't|didnt|has|hasn't|hasnt|had|can|can't|cant|could|couldn't|couldnt|will|won't|wont|would|wouldn't|wouldnt|should|shouldn't|shouldnt|may|might|must)\s+(?!(you|u|ya|we)\b)\w|(can|could|would|will)\s+(you|u)\s+(please\s+|pls\s+|just\s+|quickly\s+)?(tell\s+me|explain|clarify|describe|remind\s+me|summari[sz]e|recap|walk\s+me\s+through|(confirm|say|let\s+me\s+know)\s+(whether|if|that|what|why|how|when|where|which|who))\b|(do|did)\s+(you|u)\s+(know|remember)\b)/i;
// "do" and "have" also open orders ("do both", "have it ready"), so they ask only before I or they, before a subject, its verb and a "?", or in "do these work?".
const DO_Q =
  /^(do|have)\s+((i|they)\s+\w|(?!(you|u|ya|we|it|this|that|them|not)\b)\w+\s+(?!of\b)\w+\s+(?!(and|or|then|now|right|too|first|next|again|today|tonight|please|pls|asap|later|also)\b)\w[^?]*\?)|^do\s+(these|those)\s+(?!(and|or|then|now|right|too|first|next|again|today|tonight|please|pls|asap|later|also|as|in|on|for|with|instead|one|ones|two|three|all|both)\b)[a-z]+\b[^?]*\?/i;
// "성능 어때?" and "화면 어때?" ask how something is, "하면 어때?" and "하는 게 어때?" suggest; "윈도우에서도 돼?" asks whether it works there, "지워도 돼?" asks leave; "되는지 알려줘" asks to be told.
const KO_ASKS = /(?<!([^화장]면|는 ?[거게건걸것])\s*)(어때|어떨까)|(에서|에|으로|로|랑|이랑|하고|까지)도 ?(돼|되|될)|지 ?(알려|설명해|말해) ?(줘|줄래|주세요|주실|줄 ?수 ?있)/g;
const REPORTED = /^(switched|done)\b/i;
const ENDS_Q = /\?[\s!?.)]*((lol|lmao|haha)\s*)?\W*$/i;
const TAG_Q = /\b(right|correct|or not|or no)[\s.!]*$/i;

// each sentence as typed, and without the filler it opens with
const parts = (raw: string) =>
  raw
    .split(SENTENCE)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => ({ part, sentence: part.replace(LEAD, "").replace(KO_LEAD, "").trim() }));

const orders = ({ part, sentence }: { part: string; sentence: string }) =>
  (REQUEST.test(part) && !INFO_Q.test(sentence) && !DO_Q.test(sentence)) ||
  KO_REQUEST.test(part.replace(KO_ASKS, "")) ||
  PICK.test(sentence) ||
  KO_PICK.test(sentence) ||
  (COMMAND.test(sentence) && !REPORTED.test(sentence) && !QUESTION_START.test(sentence));

// "can you help me out?" asks for work, so only the bot answers it; "can you tell me why?" asks for a fact.
const ASKS_WORK = /^(can|could|would|will)\s+(u|you|ya)\b/i;
const asksSomething = (sentence: string) =>
  !(ASKS_WORK.test(sentence) && !INFO_Q.test(sentence)) &&
  (ENDS_Q.test(sentence) || QUESTION_START.test(sentence) || INFO_Q.test(sentence) || DO_Q.test(sentence) || KO_QUESTION.test(sentence) || TAG_Q.test(sentence));

// A nudge asks to be answered and says nothing else: "sidekick answer me", "answer me??", "hello?", "you there?". "ok" or "lol" alone is no nudge, and "don't answer" refuses.
const NUDGE = new RegExp(`^((${CASUAL_WORD}|me|my|question|q|now|already|someone|anyone|anybody|come on|답 ?좀|빨리)(?=$|[\\s,.!?~])[\\s,.!?~]*)+$`, "i");
const NUDGE_SIGNAL = /\?|\b(answer|reply|respond|sidekick|side ?bot|helper|hi+|hello+|hey+|yo+|ping|there|anyone|anybody|someone)\b|사이드킥|사이드 ?봇|대?답|안녕|거기/i;
const NUDGE_NOT = /\b(dont|don'?t|do not|never|no|stop)\b/i;

/** Only asks for an answer: the helper answers the person's question still waiting above it, if any. */
export const isNudge = (raw: string) => {
  const text = raw.trim();
  return Boolean(text) && NUDGE.test(text) && NUDGE_SIGNAL.test(text) && !NUDGE_NOT.test(text);
};

/** An order or a decision for the bot, whose meaning only the bot may read. */
export const isOrder = (raw: string) => parts(raw).some(orders);

/** The sentences that ask and order nothing, as typed; "" when none asks. */
export const questionPart = (raw: string) =>
  parts(raw)
    .filter((part) => !orders(part) && asksSomething(part.sentence))
    .map(({ part }) => part)
    .join(" ");

/** "quick": the helper tries it first, then confirms or hands off. "aside": the bot takes it now and the helper answers only its question part. "main": the bot alone. */
export function nominate(raw: string): "quick" | "aside" | "main" {
  const whole = raw.trim();
  if (!whole) return "main";
  // the rest decides; nothing left means it only greets or pings
  const text = HELLO.test(whole) ? whole.split(SENTENCE).filter((sentence) => !CASUAL.test(sentence.trim())).join("\n") : whole;
  if (!text.trim()) return "quick";
  const sentences = text
    .split(SENTENCE)
    .map((sentence) => sentence.trim().replace(LEAD, "").replace(KO_LEAD, "").trim())
    .filter(Boolean);
  if (!sentences.length || KO_STOP.test(text) || sentences.some((sentence) => (STEER.test(sentence) && !DO_Q.test(sentence)) || KO_STEER.test(sentence))) return "main";
  if (whole.length > MAX_CHARS || ATTACH_OR_LINK.test(whole) || REQUEST.test(text) || REPORT.test(text) || KO_REQUEST.test(text) || KO_REPORT.test(text)) return "aside";
  if (sentences.some((sentence) => COMMAND.test(sentence) && !QUESTION_START.test(sentence))) return "aside";
  const last = sentences.at(-1)!;
  const asks = sentences.some((sentence) => ENDS_Q.test(sentence)) || QUESTION_START.test(last) || KO_QUESTION.test(last) || TAG_Q.test(last);
  return asks ? "quick" : "aside";
}
