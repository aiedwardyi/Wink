import type { PhoneRelayStatus } from "../shared/relay-protocol.ts";
import { REPORT_OWNER } from "../shared/team-report.ts";

export const TEAM_REPORT_RULE = " Use report_issue to collect and send without another approval only when the user's own text outside quotes, code and pasted logs ends a sentence with 에디에게 보내 (spacing, 보네 typo and 줘/줘요/주세요/줄래/줄래요/요 endings allowed), reusing the saved report after failed or unconfirmed delivery if repeated without a new attachment.";

const CALL_PHRASE = /에디\s*에게\s*보[내네](?:[ \t]*(?:줘요?|주세요|줄래요?|요))?[ \tㅋㅎㅠㅜ~^。！？]*(?:[.!?…]|\r?\n|$)/u;

export function teamReportPrompt(status: PhoneRelayStatus, owner: string | null): string {
  return status.state === "connected" && owner && REPORT_OWNER.test(owner) && status.reportOwner === owner ? TEAM_REPORT_RULE : "";
}

export function requestText(raw: string): string {
  return raw.replace(/<pasted-text\b[^>]*>[\s\S]*?(?:<\/pasted-text>|$)/gi, "")
    .replace(/<attached-(?:image|file)\b[^>]*>/gi, "")
    .replace(/```[\s\S]*?(?:```|$)/g, "").replace(/^\s*>.*$/gm, "")
    .replace(/["“][^"”]*["”]|‘[^’]*’|「[^」]*」|『[^』]*』|`[^`]*`|(?<![\p{L}\p{N}])'[^'\n]+'(?![\p{L}\p{N}])/gu, "").trim();
}

export function reportIntent(raw: string): "send" | "none" {
  const text = requestText(raw);
  if (/(?:imported|forwarded|quoted|transcript|인용|전달받은)\s*(?:text|message|instructions|내용|메시지)?\s*:/i.test(text)) return "none";
  return CALL_PHRASE.test(text) ? "send" : "none";
}
