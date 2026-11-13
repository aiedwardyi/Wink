export const BLIP_NUDGE = "Continue from where you were.";
const NUDGE_AFTER_MS = [30_000, 60_000, 120_000];
const ENTER_AFTER_MS = 1_000;
const BORDER_RE = /^[─━]+$/u;
const API_ERROR_RE = /\bAPI Error:/i;
const BLIP_RE = /\b5\d\d\b|\bcloudflare\b|\battention required!|\bjust a moment\b|\boverloaded\b|\binternal server error\b|\bbad gateway\b|\bservice unavailable\b/i;
const NOT_BLIP_RE = /\blimit\b|\bquota\b|\bbilling\b|\bcredits?\b/i;

/** Claude Code's latest output is a provider blip's API error, above an empty prompt. */
export function claudeApiBlip(screenText) {
  const lines = screenText.split("\n").map((line) => line.trimEnd());
  const prompt = lines.findLastIndex((line) => /^\s*[>❯]\s*$/u.test(line));
  if (prompt < 1 || !BORDER_RE.test(lines[prompt - 1].trim())) return false;
  const above = lines.slice(0, prompt - 1);
  const start = above.findLastIndex((line) => /^\s*●/u.test(line));
  if (start < 0) return false;
  // a wrapped row continues the error; a tool row or a menu means newer output
  const rest = above.slice(start + 1).filter((line) => line.trim() && !/^\s*✻ \S+ for \d/u.test(line));
  if (rest.some((line) => /^\s*[⎿❯›]|^\s*\d+\.\s/u.test(line))) return false;
  const error = [above[start], ...rest].join(" ");
  return API_ERROR_RE.test(error) && BLIP_RE.test(error) && !NOT_BLIP_RE.test(error);
}

/** Types the nudge into a Claude pane stopped on a blip, up to three times a streak.
 * True while the nudge owns the pane, so no STALLED note goes out yet. */
export function nudgeApiBlip(session, screenText, at, busy, type) {
  if (session.engine !== "claude") return false;
  const nudge = session.blipNudge ??= { count: 0, typedAt: 0, at: -Infinity };
  if (nudge.typedAt) {
    // text and Enter in one write lands as a paste that never submits
    if (at - nudge.typedAt < ENTER_AFTER_MS) return true;
    const ours = session.userInputAt < nudge.typedAt && screenText.includes(BLIP_NUDGE);
    nudge.typedAt = 0;
    // a user who edited or replaced the nudge keeps their draft unsent
    if (ours) {
      type("\r");
      return true;
    }
  }
  // the pane gets a moment to react before its old screen counts as stuck
  if (session.stallChangedAt <= nudge.at && at - nudge.at < NUDGE_AFTER_MS[0]) return true;
  if (!claudeApiBlip(screenText)) {
    // the streak ends once the pane settles on anything else
    if (!busy && at - session.stallChangedAt >= NUDGE_AFTER_MS[0]) nudge.count = 0;
    return false;
  }
  if (nudge.count >= NUDGE_AFTER_MS.length) return false;
  // a user at the prompt owns the pane, and the usual STALLED path watches it
  if (session.userInputAt >= session.stallChangedAt) return false;
  if (at - session.stallChangedAt < NUDGE_AFTER_MS[nudge.count]) return true;
  nudge.count += 1;
  nudge.typedAt = at;
  nudge.at = at;
  type(BLIP_NUDGE);
  return true;
}
