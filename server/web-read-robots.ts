// robots.txt for web_read (RFC 9309): Wink is not a named crawler, so only the "*" group applies.
// Allow/Disallow patterns support * and $; the longest matching pattern wins, and Allow wins a tie.

export type RobotsRule = { allow: boolean; pattern: string };

/** RFC 9309 asks readers to parse at least 500 KiB; more than that is ignored. */
const PARSE_BYTES = 512_000;

function normalize(path: string): string {
  try {
    return encodeURI(decodeURI(path));
  } catch {
    return path;
  }
}

/** The rules of every "*" group in a robots.txt body. */
export function parseRobots(body: string): RobotsRule[] {
  const rules: RobotsRule[] = [];
  let agents: string[] = [];
  let inRules = false;
  for (const raw of body.slice(0, PARSE_BYTES).split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const match = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    if (key === "user-agent") {
      if (inRules) agents = [];
      inRules = false;
      agents.push(value.toLowerCase());
    } else if (key === "allow" || key === "disallow") {
      inRules = true;
      // An empty Disallow allows everything, so it adds no rule.
      if (agents.includes("*") && value) rules.push({ allow: key === "allow", pattern: normalize(value) });
    }
  }
  return rules;
}

function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split("*");
  if (!path.startsWith(parts[0]!)) return false;
  let at = parts[0]!.length;
  for (let i = 1; i < parts.length; i++) {
    const found = path.indexOf(parts[i]!, at);
    if (found < 0) return false;
    at = found + parts[i]!.length;
  }
  if (!anchored) return true;
  // Parts matched leftmost; with $ the last part must also sit at the very end (it does whenever it ends the path, since its leftmost match fit).
  return parts.length === 1 ? path === parts[0] : path.endsWith(parts.at(-1)!);
}

/** Whether rules let a reader open a path (pathname + query). */
export function robotsAllows(rules: readonly RobotsRule[], pathAndQuery: string): boolean {
  const path = normalize(pathAndQuery || "/");
  let best: RobotsRule | undefined;
  for (const rule of rules) {
    if (!matches(rule.pattern, path)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) best = rule;
  }
  return best ? best.allow : true;
}
