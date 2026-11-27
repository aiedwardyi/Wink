// The Claude CLI's exact text when it can't use a Pro or Max subscription (checked against claude 2.1.332).
const PAYMENT_DUE = "Claude Code can't use your Claude subscription, usually because a payment is past due";

export function isPaymentDue(message: string): boolean {
  return message.includes(PAYMENT_DUE);
}

export function isSignOut(message: unknown): boolean {
  return /(?:\bstatus\s*:?\s*401\b|\bHTTP(?:\/[\d.]+)?\s+401\b|\b401\s+unauthorized\b|\bmissing bearer\b|(?<!\bproxy[\s-])\bauthentication required\b|\bnot (?:logged|signed) in\b|\bAPI Error:\s*401\s*\{[^\n]*"type"\s*:\s*"authentication_error"|\bOAuth session expired\b|\blogin (?:has )?expired\b|\blogin reached its time limit\b|\bOAuth token (?:has been )?revoked\b|\bClaude session has expired\b|\brun \/login\b|\bunauthori[sz]ed\s*\(code\s*401\)|\bstill unauthorized after a token refresh\b|\bAPI key\b[^\n]{0,40}\bwas rejected\b|\brun `(?:muse|grok) login`)/i.test(String(message ?? ""));
}
