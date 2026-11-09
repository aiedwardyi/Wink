export function isSignOut(message: unknown): boolean {
  return /(?:\bstatus\s*:?\s*401\b|\bHTTP(?:\/[\d.]+)?\s+401\b|\b401\s+unauthorized\b|\bmissing bearer\b|(?<!\bproxy[\s-])\bauthentication required\b|\bnot (?:logged|signed) in\b|\bAPI Error:\s*401\s*\{[^\n]*"type"\s*:\s*"authentication_error")/i.test(String(message ?? ""));
}
