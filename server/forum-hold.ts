// What the Forum may hold back from the user. Delivering the card or the call is the default.
import type { BoardPost } from "./board.ts";

/** Sign-in, money and shipping reach the user even when the bot marks them as a fact. */
const NEVER_HOLD = /\b(?:log ?in|sign ?in|password|pay|money|price|cost|bill|push|merg|releas)/i;

/** Of the asks a bot marked as a fact, only a plain question with no choices may wait on the Forum. */
export const mayHoldAsk = (question: string, choices: readonly string[]) => !choices.length && !NEVER_HOLD.test(question);

/** A top-level solved fix: never a reply, tip, handoff or open post. */
export const solvedFix = (post: BoardPost) =>
  post.parent_id === null && (post.kind === "stuck" || post.kind === "fix") && post.status === "solved" && Boolean(post.fix.trim());
