// Gate 1 of the quick router: nominate a busy-time message for the quick helper. Anything unsure goes to the bot.
const MAX_CHARS = 240;
const ATTACH_OR_LINK = /<attached-(image|file)|https?:\/\//i;
// Filler a sentence may open with, stripped before the checks ("okay great.", "hahaha", "wait", "btw").
const LEAD =
  /^((["'“”]+|(ok|okay|k|kk|yeah|yea|ya|true|great|cool|nice|perfect|awesome|got it|thanks|thx|ty|lol|lmao|haha\w*|wow|oh|ah|hmm+|hey|yo|wait|actually|but|and|also|then|plus|btw|so|anyway|afterwards|later|first|next|now|after that|maybe)\b)[\s,.!:]*)+/i;
// Approvals, refusals, pauses and suggestions steer the running work, whatever follows.
const STEER =
  /^(yes|yep|yup|go|go ahead|go for it|do (it|that|this|both|all|them)|let'?s do|ship it|merge it|push it|lgtm|sounds good|sure|alright|dont|don't|do not|no|nope|never|stop|pause|hold on|cancel|instead|nvm|never ?mind|how about|what about|what if|why not|why don'?t (we|you|u))\b/i;
const COMMAND =
  /^(ship|merge|push|deploy|release|continue|resume|switched|done|fix|add|make|build|change|update|remove|delete|rename|run|install|use|try|send|give|put|move|record|save|write|create|open|check|test|keep|let'?s|lets|please|pls|plz|start|restart|reinstall|set|turn|upload|download|buy|grab|park|skip|drop|revert|undo|approve|allow|deny|retry|redo|finish|wrap|close|launch|publish|post|get|tell (him|her|them|pokkey|wink|\w+ bot))\b/i;
// "can you <verb>", "can we <verb>" (not "when can we"), "please": asks the bot to act, even with a question mark.
const REQUEST =
  /\b((can|could|would|will|wanna|want to)\s+(u|you|ya)|(?<!\b(when|what|how|why|where|which)\s)(can|could|shall)\s+we)\s+(please\s+|pls\s+|also\s+|just\s+|quickly\s+)?(save|fix|add|make|build|change|update|remove|delete|run|install|send|merge|push|deploy|create|write|move|rename|restart|reinstall|switch|start|stop|try|test|use|do|set|turn|put|upload|download|buy|record|open|check|look|find out|go|get|post|share|draft|redo|retake|apply|commit|launch|spawn|mind|ask|tell (him|her|them|pokkey|wink))\b|\b(please|pls|plz|asap|let'?s|lets)\b/i;
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
  /((줘|줄래|볼까|볼래|할까|할래)요?|하자|말고|지 ?마(요|라|세요)?)(?=$|[\s,.!?~ㅋㅎㅠㅜ])|주세요|주시|주실|줄 ?수 ?있|도 ?(돼|되|될)|어때|어떨까/;
const KO_REPORT = /버그|고장|크래시|안 ?(돼|되|됨)|같은데|[는은인]데[\s,]+\S/;
// 뭐든 and 왜냐하면 open statements.
const KO_QUESTION = /^(뭐|무엇|어디|언제|왜|어떻게|얼마|몇|누가|어느)(?!든|냐하?면)|(나요|까요|인가요?|일까)\?*$/;
const ENDS_Q = /\?[\s!?.)]*((lol|lmao|haha)\s*)?\W*$/i;
const TAG_Q = /\b(right|correct|or not|or no)[\s.!]*$/i;

/** "quick" when the helper should try it first. Never trusted alone: the helper confirms or hands off. */
export function nominate(raw: string): "quick" | "main" {
  const text = raw.trim();
  if (!text || text.length > MAX_CHARS || ATTACH_OR_LINK.test(text) || REQUEST.test(text) || REPORT.test(text) || KO_REQUEST.test(text) || KO_REPORT.test(text)) return "main";
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim().replace(LEAD, "").replace(KO_LEAD, "").trim())
    .filter(Boolean);
  if (!sentences.length || sentences.some((sentence) => STEER.test(sentence) || KO_STEER.test(sentence) || (COMMAND.test(sentence) && !QUESTION_START.test(sentence)))) return "main";
  const last = sentences.at(-1)!;
  const asks = sentences.some((sentence) => ENDS_Q.test(sentence)) || QUESTION_START.test(last) || KO_QUESTION.test(last) || TAG_Q.test(last);
  return asks ? "quick" : "main";
}
