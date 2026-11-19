import { domainToASCII } from "node:url";

/** A relay base domain, lowercase: at least two dot-separated DNS labels. The server and the desktop both check with this one. */
export const RELAY_BASE_RE = /^(?=.{3,200}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

// The server's status and the desktop's copy from config.json must spell a saved relay the same way.
// domainToASCII also drops a path or query, so only a bare name gets its spelling.
export function relayHost(base) {
  const host = String(base ?? "").trim().toLowerCase();
  const ascii = /^[\p{L}\p{M}\p{N}.-]+$/u.test(host) ? domainToASCII(host) : "";
  return (ascii || host).replace(/\.$/, "") || null;
}
