import { randomBytes } from "node:crypto";

const BOT_ROUTE = /^\/api\/(?:internal\/(?:agents|ask-bot|ask-user|board-post|board-search|call-api|create-bot|create-channel|delegate-bot|delegations\/[^/]+|generate-image|keep-going|launch-note|my-chats|react|request-credential|room-fix|routine-requests|routines|show-image|spawn-usage|task-state|team-report|usage|verify-site|wake|worker-playbook)|verify\/runs\/[a-z0-9-]{8,64}\/(?:live|replay))$/;

/** A bot's own token opens only the routes its agents and terminal tools call (Antigravity hands both its token), plus its own worker map; the boot token opens the rest. */
export function botRoute(path: string, botId: string): boolean {
  return BOT_ROUTE.test(path) || path.startsWith(`/api/bots/${botId}/map/`) && /^(?:live|file|repo|flow)$/.test(path.slice(`/api/bots/${botId}/map/`.length));
}

export class CommsCallers {
  private readonly tokens = new Map<string, string>();
  private readonly callers = new Map<string, { botId: string; threadId: string }>();

  token(botId: string, threadId: string): string {
    const key = `${botId}\0${threadId}`;
    let token = this.tokens.get(key);
    if (!token) {
      token = randomBytes(24).toString("hex");
      this.tokens.set(key, token);
      this.callers.set(token, { botId, threadId });
    }
    return token;
  }

  resolve(header: string | string[] | undefined): { botId: string; threadId: string } | undefined {
    return typeof header === "string" && header.startsWith("Bearer ") ? this.callers.get(header.slice(7)) : undefined;
  }
}
