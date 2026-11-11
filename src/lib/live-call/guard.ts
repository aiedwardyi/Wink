// What the voice's turn claims, one sentence at a time: a promise of work, a refusal, a dodge, or an honest "not sent".

export type Claim = "promise" | "cant" | "unsure" | "failed";

const ACTION_EN = /\b(?:(?:i'?ll|i will|i am going to|i'?m going to|let me|let's|i'?m|i am|i'?ve|i have|i just|i already)\s+(?:certainly\s+|just\s+|now\s+|already\s+|go ahead and\s+)?(?:check|checking|checked|look|looking|looked|find|finding|found|ask|asking|asked|open|opening|opened|add|adding|added|send|sending|sent|start|starting|started|get started|handle|handling|fix|fixing|fixed|schedule|scheduled|restart|restarting|run|running|ran|take care|go ahead|proceed|work on|working on)|i (?:checked|looked|found|asked|opened|added|sent|started|fixed|scheduled|restarted|ran))\b(?!\s+(?:late|behind|out|low)\b)/i;
const ON_IT = /^(?:(?:okay|ok|sure|got it|alright|right)[,!.]?\s+)?(?:i'?m\s+)?on it\b/i;
const ACTION_KO = /확인해\s?(?:볼게|보겠|드릴게|드리겠)|확인했|알아\s?(?:볼게|보겠)|알아봤|찾아\s?(?:볼게|보겠)|찾았|열어\s?(?:볼게|드릴게|드리겠)|열었|추가했|추가해\s?(?:둘게|드릴게|놓을게)|바로\s?(?:확인|진행|처리)|진행할게|진행하겠|처리할게|처리하겠|보내\s?드릴게|보냈|물어\s?(?:볼게|보겠)/;
const CANT = /\b(?:i can(?:not|'?t)|i'?m unable|i am unable|unable to|i (?:don'?t|do not) have access|no access)\b[^.!?]*\b(?:open|access|see|check|find|look|do|interact|reach|read|run)\b|(?:열|볼|접근할|확인할|찾을|실행할|읽을|들어갈) 수(?:가)? 없|권한이 없/i;
const UNSURE = /\b(?:not (?:entirely |quite |really |completely )?sure|i (?:don'?t|do not) know|i (?:don'?t|do not) (?:report|provide|track)|i (?:don'?t|do not) have (?:that |this |any |the )?(?:info|information|data|details|access))\b|잘 모르|모르겠|알 수 없|정보가 없/i;
// An offer, question or condition promises nothing yet.
const HYPOTHETICAL = /\?\s*$|\b(?:if you|let me know|whenever|once you|when you|would you like|do you want|want me to|shall i|should i)\b|시면|으면|할까요|드릴까요|볼까요/i;
const CLARIFY = /\b(?:heard|hear you|catch that|repeat|say that again|what you mean)\b|다시 말씀|다시 한 ?번|못 들었|잘 안 들/i;
// What a recap reports as done; only what is left after it can still be a promise.
const DONE = /\bi(?:'?ve| have| just| already)?\s+(?:just\s+|already\s+)?(?:checked|looked|found|asked|opened|added|sent|started|fixed|scheduled|restarted|ran)\b|확인했|알아봤|찾았|열었|추가했|보냈/gi;
const FAILED = /\b(?:nothing (?:was|has been|got) sent|(?:wasn'?t|was not|isn'?t|is not|hasn'?t been|has not been|couldn'?t be|could not be) sent|not sent|nothing is running)\b|아무것도 (?:안 )?보내지 않|보내지 (?:않았|못했)|안 보냈|전송되지 않/i;

const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);

/** The first claim in a turn; an honest "not sent" anywhere wins, and a clarification is never a dodge. */
export function claimOf(said: string, recap = false): { claim: Claim; sentence: string } | null {
  if (FAILED.test(said)) return { claim: "failed", sentence: said };
  const clarifies = CLARIFY.test(said);
  for (const sentence of sentences(said)) {
    if (HYPOTHETICAL.test(sentence)) continue;
    const ahead = recap ? sentence.replace(DONE, " ") : sentence;
    if (ACTION_EN.test(ahead) || ON_IT.test(ahead) || ACTION_KO.test(ahead)) return { claim: "promise", sentence };
    if (CANT.test(sentence)) return { claim: "cant", sentence };
    if (!clarifies && UNSURE.test(sentence)) return { claim: "unsure", sentence };
  }
  return null;
}

const CHANGES = "open|run|restart|reboot|fix|send|add|delete|remove|schedule|install|deploy|push|merge|create|write|edit|change|move|close|kill|stop|start|update|rename|commit";
const CHANGE_EN = new RegExp(`\\b(?:can|could|would|will) you (?:please )?(?:just )?(?:${CHANGES})\\b|^\\s*(?:please\\s+)?(?:${CHANGES})\\b`, "i");
const CHANGE_KO = /(?:열어|실행해|재시작해|재부팅해|고쳐|수정해|보내|추가해|삭제해|지워|예약해|설치해|배포해|푸시해|머지해|만들어|바꿔|옮겨|닫아|꺼|멈춰|시작해|켜)\s?(?:줄|줘|주세요|주실|줄래|주시겠)/;

/** A request to change something, even phrased as a question: it needs propose_work and a yes. */
export function asksForChange(question: string): boolean {
  return CHANGE_EN.test(question) || CHANGE_KO.test(question);
}

const RECAP = /^\s*(?:(?:so|and|okay|ok|hey)[,\s]+)?(?:did|have|has|had)\s+(?:you|we|they|it|he|she)\b|\bwhat\b[^.!?]*\b(?:did|have|has|had|got|was|were)\b|\b(?:recap|so far|summary|summarize)\b|뭐 했|한 일|했어\s*\??\s*$|했나요|했니|됐어\s*\?|됐나요/i;

/** A question about work already done, so its answer recounts the past. */
export function asksAboutDone(request: string): boolean {
  return RECAP.test(request);
}

const AGAIN = /\bwhat(?:'s| is| was)\s+(?:the|that|their|his|her|its)\s+question\b|\bwhat (?:did|does) (?:\w+ )?(?:ask|want)\b|\b(?:say|read) (?:that|it) again\b|\brepeat (?:that|it|the question)\b|\bcome again\b|^\s*(?:sorry|pardon|what|huh)\s*[?!.]*\s*$|질문이?\s*뭐|뭐라고|뭘 물어|뭐 물어|다시 (?:말해|말씀|읽어|한 ?번)|못 들었/i;

/** The person asking to hear the question again, which is not its answer. */
export function asksToRepeat(heard: string): boolean {
  return AGAIN.test(heard);
}
