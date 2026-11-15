// A quick call: words said while it connects are kept, and words nothing dealt with go to the bot on hang-up.
import { bareYes } from "./consent";

// 16 kHz PCM16: the 15 s a socket gets to set up.
const EARLY_MAX_BYTES = 15 * 16_000 * 2;

/** Mic audio from the tap until the voice is ready, sent the moment it is. */
export class EarlyMic {
  readonly frames: ArrayBuffer[] = [];
  spoke = false;
  private bytes = 0;

  add(pcm: ArrayBuffer, loud: boolean) {
    this.spoke ||= loud;
    this.frames.push(pcm);
    this.bytes += pcm.byteLength;
    while (this.bytes > EARLY_MAX_BYTES) this.bytes -= this.frames.shift()!.byteLength;
  }
}

const only = (words: string[]) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.join("|")})(?![\\p{L}\\p{N}])`, "giu");
// Said to the voice, not the bot: a goodbye, thanks, a hello, an ack or a mutter.
const SMALL = only([
  "good ?bye|bye(?:[ -]bye)?|good ?night|see (?:you|ya)|talk (?:to you )?(?:later|soon)|later|take care|hanging up|gotta go|that'?s (?:all|it)|thanks|thank you|cheers",
  "hi|hello|hey|yes|yeah|yep|yup|okay|ok|sure|alright|all right|right|cool|great|good|nice|perfect|got it|sounds good|fine",
  "oops|whoops|oh|ah|uh|um|er|hmm+|mm+|ugh|huh|well|so|and|sorry|my bad",
  "안녕(?:히 계세요)?|여보세요|끊을게요?|끊어요?|끊는다|들어가(?:요|세요)?|나중에 봐|이따 봐|고마워요?|고맙습니다|감사(?:합니다|해요)?|수고(?:해요?|하세요)?",
  "응|네|예|그래|알겠어요?|알았어요?|오케이|좋아요?|앗|아|어|음|흠|아이고|이런|미안(?:해요?)?|죄송(?:해요|합니다)?",
]);
// Telling the voice to stop also takes back what he said before it.
const BACK = only(["stop(?: it)?|wait|hold on|never ?mind|forget (?:it|that)|cancel(?: (?:it|that))?|no|nope|scratch that", "그만(?:해요?)?|잠깐만?|됐어요?|아니(?:야|요|다)?|취소(?:해요?)?|하지 ?마|신경 ?쓰지 ?마"]);
const blank = (text: string) => !/[\p{L}\p{N}]/u.test(text);

/** His lines that no reply or send has dealt with yet, by line number. */
export class OpenLines {
  private lines: Array<{ n: number; text: string }> = [];

  add(n: number, text: string) {
    this.lines.push({ n, text });
  }

  /** Lines up to `n` were answered or reached the bot. */
  settle(n: number) {
    this.lines = this.lines.filter((line) => line.n > n);
  }

  /** What goes to the bot on hang-up: nothing unless a line holds more than words for the voice, and a yes only beside one. */
  text(): string {
    let kept: string[] = [];
    let real = false;
    for (const { text } of this.lines) {
      const rest = text.replace(SMALL, " ");
      if (!blank(rest.replace(BACK, " "))) real = true;
      else if (!blank(rest)) {
        kept = [];
        real = false;
        continue;
      } else if (!bareYes(text)) continue;
      kept.push(text);
    }
    return real ? kept.join(" ") : "";
  }
}
