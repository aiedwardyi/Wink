import { stripVTControlCharacters } from "node:util";

import { buildToolDetail } from "../shared/tool-detail.ts";
import { redactSecretsInText } from "./redact.ts";
import type { Message } from "./store.ts";

export const SECRET_COMMAND = /token|secret|password|passwd|credential|api[\s_-]*key|(?:^|[\s;/\\|&()'"])(?:env|printenv|set)(?=$|[\s;|&()'"])|\b(?:cat|type|get-content)\b[^\r\n;&|]*\.env/i;
const CREDENTIAL_ASSIGNMENT = /(?<![A-Za-z0-9_-])(?:[A-Za-z0-9_-]+[_-])?(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASS|CREDENTIALS?|AUTH|SESSION)["']?\s*[=:]\s*/gi;
// CREDENTIAL_ASSIGNMENT minus its prefix and lookbehind: a line this misses has no assignment.
const ASSIGNMENT_HINT = /(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASS|CREDENTIALS?|AUTH|SESSION)["']?\s*[=:]/i;
const CREDENTIAL_HEADER = /(\b(?:Cookie|Set-Cookie|(?:Proxy-)?Authorization)\s*:\s*)(.*)$/i;
const MASKED_VALUE = /^«redacted \d+ chars»/;
// The chain only rewrites Cc/Cf (ESC, CSI, CR, tab are Cc), which printable ASCII lacks.
const UNPRINTABLE = /[^\n\x20-\x7e]/;
const CONTROL = /(?!\n)[\p{Cc}\p{Cf}]/u;
// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Stored rows are unparsed JSON; a non-string must still reach the chain's type error.
export const normalize = (text: string) => typeof text === "string" && !(UNPRINTABLE.test(text) && CONTROL.test(text)) ? text : stripVTControlCharacters(text).replace(/\r\n/g, "\n").replace(/\t/g, " ").replace(/(?!\n)[\p{Cc}\p{Cf}]/gu, "");
const mask = (text: string) => /^«redacted \d+ chars»$/.test(text) ? text : `«redacted ${text.length} chars»`;

export function sensitivePath(path: string): boolean {
  const normalized = normalize(path).replace(/\\/g, "/").replace(/^["']|["']$/g, "");
  if (/(^|\/)\.(?:ssh|gnupg)(\/|$)/i.test(normalized)) return true;
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  return /\.(?:pem|key|p12|pfx|jks|keystore|ppk|kdbx)$|^id_(?:rsa|dsa|ecdsa|ed25519)|^\.env(?:\.|$)|^\.(?:netrc|pgpass|npmrc|pypirc)$|^credentials|secret/i.test(name);
}

export function redactPreview(text: string): string {
  const safe = normalize(text).split("\n").map((line) => {
    if (/^[+-]?[A-Za-z0-9+/=]{40,}$/.test(line) && /[A-Z]/.test(line) && /[a-z]/.test(line) && /\d/.test(line) && !/^[+-]?[a-f0-9]+$/i.test(line)) {
      return /^[+-]/.test(line) ? line[0] + mask(line.slice(1)) : mask(line);
    }
    if (line.includes("://")) line = line.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/?#]+)@/gi, (_match, scheme: string, userinfo: string) => `${scheme}${mask(userinfo)}@`);
    const header = CREDENTIAL_HEADER.exec(line);
    if (header) return header[2].trim() ? line.slice(0, header.index) + header[1] + mask(header[2]) : mask(line);
    if (!ASSIGNMENT_HINT.test(line)) return line;
    let out = "";
    let cursor = 0;
    for (const assignment of line.matchAll(CREDENTIAL_ASSIGNMENT)) {
      if (assignment.index < cursor) continue;
      const start = assignment.index + assignment[0].length;
      const rest = line.slice(start);
      const quoted = /^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/.exec(rest)?.[0];
      const value = quoted ?? MASKED_VALUE.exec(rest)?.[0] ?? /^[^\s"',;]+/.exec(rest)?.[0];
      if (!value) return mask(line);
      const tail = rest.slice(value.length);
      if (quoted ? tail && !/^[\s,;}\]]/.test(tail) : /\S/.test(tail) && !/^[,;}\]]/.test(tail) && !/^\s+\S+["']?\s*[=:]/.test(tail)) return mask(line);
      out += line.slice(cursor, start) + (quoted ? value[0] + mask(value.slice(1, -1)) + value.at(-1) : mask(value));
      cursor = start + value.length;
    }
    return out + line.slice(cursor);
  }).join("\n");
  return redactSecretsInText(safe);
}

export function redactToolMessage<T extends Pick<Message, "tool">>(message: T): T {
  const source = message.tool?.detail;
  if (!source) return message;
  const input = normalize(source.input ?? "");
  const detail = buildToolDetail({
    ...source,
    output: source.output?.join("\n"),
    outputHidden: source.outputHidden || SECRET_COMMAND.test(input) || input.split(/,\s*/).some(sensitivePath),
  }, redactPreview);
  return { ...message, tool: { ...message.tool, detail } };
}
