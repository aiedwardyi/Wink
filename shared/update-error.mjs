// Network blips and GitHub 5xx/429 heal on their own; signature and checksum failures do not.
const TRANSIENT = /\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EPIPE)\b|net::ERR_|socket hang up|timed? ?out|^\s*(?:5\d\d|429)\b|status (?:5\d\d|429)\b/i;

export function isTransientUpdateError(message) {
  return typeof message === "string" && TRANSIENT.test(message);
}
