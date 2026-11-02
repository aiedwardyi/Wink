import { randomBytes } from "node:crypto";

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
