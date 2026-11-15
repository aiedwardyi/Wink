/** An engine summary of a bot's mid-turn note is not the bot's words, a room echo is the bot's own memory, and a tapped choice reads on its card, so the user never sees any of them. */
export function isShownMessage(message: { role?: string; summarized?: boolean; roomEcho?: unknown; answersCard?: string }): boolean {
  return !(message.role === "bot" && (message.summarized || message.roomEcho)) && !message.answersCard;
}
