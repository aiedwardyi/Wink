import { domainToASCII } from "node:url";

// The server's status and the desktop's copy from config.json must spell a saved relay the same way.
export function relayHost(base) {
  const host = String(base ?? "").trim().toLowerCase();
  return (domainToASCII(host) || host).replace(/\.$/, "") || null;
}
