/** An engine summary of a bot's mid-turn note is not the bot's words, and a room echo is the bot's own memory, so the user never sees either. */
export function isShownMessage(message: { role?: string; summarized?: boolean; roomEcho?: unknown }): boolean {
  return !(message.role === "bot" && (message.summarized || message.roomEcho));
}
