export function isSignOut(message: unknown): boolean {
  return /(?:\bstatus\s*:?\s*401\b|\bHTTP(?:\/[\d.]+)?\s+401\b|\b401\s+unauthorized\b|\bmissing bearer\b|(?<!\bproxy[\s-])\bauthentication required\b|\bnot (?:logged|signed) in\b|\bAPI Error:\s*401\s*\{[^\n]*"type"\s*:\s*"authentication_error"|\bOAuth session expired\b|\blogin (?:has )?expired\b|\blogin reached its time limit\b|\bOAuth token (?:has been )?revoked\b|\bClaude session has expired\b|\brun \/login\b)/i.test(String(message ?? ""));
}
