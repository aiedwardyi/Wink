// What the Forum may hold back from the user. Delivering the card or the call is the default.
import type { BoardPost } from "./board.ts";

/** Decisions, consent, sign-in, money, deleting and shipping always reach the user, whatever the Forum holds. */
const MUST_ASK = /\b(?:approv\w*|permission\w*|allow\w*|authori[sz]\w*|consent\w*|confirm\w*|ok|okay|go ahead|proceed\w*|log ?in\w*|log ?out\w*|sign[ -]?(?:in|on|up|out)\w*|password\w*|passcode\w*|2fa|mfa|otp|credential\w*|account\w*|token\w*|keys?|secret\w*|pay\w*|billing|bills?|invoice\w*|subscri\w*|purchas\w*|buy\w*|charg\w*|pric\w*|cost\w*|refund\w*|spend\w*|money|delet\w*|remov\w*|eras\w*|wip(?:e|es|ed|ing)|purg\w*|destroy\w*|discard\w*|overwrit\w*|reset\w*|uninstall\w*|drop\w*|merg\w*|push\w*|deploy\w*|releas\w*|publish\w*|ship\w*|choos\w*|chose\w*|choice\w*|pick\w*|prefer\w*|option\w*|decid\w*|decision\w*|rather|or|should|shall|want\w*|would you|which one|which of)\b/i;

/** Only a plain question with no choices may wait on the Forum. */
export const mayHoldAsk = (question: string, choices: readonly string[]) => !choices.length && !MUST_ASK.test(question);

/** A top-level solved fix: never a reply, tip, handoff or open post. */
export const solvedFix = (post: BoardPost) =>
  post.parent_id === null && (post.kind === "stuck" || post.kind === "fix") && post.status === "solved" && Boolean(post.fix.trim());
