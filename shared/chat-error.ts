export type ChatError =
  | { kind: "quiet"; site: "chatRace" | "chatQueue" }
  | { kind: "keep"; raw: string }
  | { kind: "known"; key: "errors.stopped" | "errors.model" | "errors.apps" | "errors.engine" | "errors.sendTaskChanged" | "errors.stopTaskChanged" | "chat.busyGaveUp" | "errors.signedOut" | "errors.engineStopped" | "errors.signInChanged" | "errors.hookDenied" | "errors.codexPromo"; vars?: Record<string, string | number>; raw?: string }
  | { kind: "unknown"; raw: string };

export function classifyChatError(line: string): ChatError {
  const raw = line.replace(/^error:\s*/, "");
  const queued = /^queued (?:message|room turn) could not start\s*[-\u2014]\s*/.test(raw);
  const reason = raw.replace(/^queued (?:message|room turn) could not start\s*[-\u2014]\s*/, "");
  if (reason.includes("codex_byok_restricted_by_api_credit_promo") || reason === "This OpenAI key's org is on API credit, which Codex can't use. Pick another Codex account.") return { kind: "known", key: "errors.codexPromo" };
  if (/^the (?:bot|channel) switched tasks before it could receive the message$/i.test(reason)) return { kind: "known", key: "errors.sendTaskChanged" };
  if (/^the (?:bot|channel) switched tasks before it could be interrupted$/i.test(reason)) return { kind: "known", key: "errors.stopTaskChanged" };
  if (/^(?:Claude is not signed in\.|Grok CLI is not signed in|Grok runs in WSL\.|`[^`]+` isn't installed|Project folder not found:)/.test(reason)) return { kind: "keep", raw };
  if (/^(?:a turn is already running on this thread|turn cancel(?:led|ed) before dispatch|the bot is (?:already working|still stopping its last turn)|sendId already belongs to another message)/i.test(reason)
    || (queued && reason === "no such task")) {
    return { kind: "quiet", site: queued ? "chatQueue" : "chatRace" };
  }
  const stopped = /^no activity for (\d+) minutes\s*[-\u2014]\s*the turn was stopped$/.exec(reason);
  if (stopped) return { kind: "known", key: "errors.stopped", vars: { minutes: stopped[1] } };
  if (/^(?:provider|model) instance .*unavailable|model is unavailable|no working engine supports/.test(reason)) return { kind: "known", key: "errors.model" };
  if (/^connected apps are unavailable/.test(reason)) return { kind: "known", key: "errors.apps" };
  if (reason === "This account is signed out. Sign in again, then send your message.") return { kind: "known", key: "errors.signedOut" };
  if (reason === "Gemini is still busy after 3 tries. Try another model.") return { kind: "known", key: "chat.busyGaveUp" };
  const selfStopped = /^(.+?) stopped this reply on its own(?: \((.+)\))?$/.exec(reason);
  if (selfStopped) return { kind: "known", key: "errors.engineStopped", vars: { engine: selfStopped[1] }, raw: selfStopped[2] ? reason : undefined };
  const hook = /^(.+?) hook failed \(([^()]+)\)(?:: (.+))?$/.exec(reason);
  if (hook) return { kind: "known", key: "errors.hookDenied", vars: { engine: hook[1], hook: hook[2] }, raw: hook[3] };
  if (reason === "the sign-in changed while the reply was starting") return { kind: "known", key: "errors.signInChanged" };
  if (/^(?:\w+ exited \d+ before result:|stream disconnected before completion|spawn failed:|Internal error$|Resource exhausted\.)/i.test(reason)) return { kind: "known", key: "errors.engine" };
  return { kind: "unknown", raw };
}

export function quietUsageError(line: string): boolean {
  return /^(?:Usage refresh is not supported|Claude refresh skipped to avoid Keychain prompts on macOS)$/.test(line);
}
