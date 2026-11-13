// Which bot a team room message wakes: the first @bot by position, else the
// bot whose entry it replies to, else the only bot for a line that tags no one.
// @everyone and people's names wake nobody.
// The server and the composer share it so the hint matches what runs.

const fold = (text: string) => text.normalize("NFC").toLowerCase();

export function roomResponder<T extends { id: string; name: string }>(
  text: string,
  bots: readonly T[],
  people: readonly string[],
  replyToBotId?: string,
  soloWakes = true,
  otherBots: readonly string[] = [],
): T | null {
  const otherNames = new Set(otherBots.map((name) => fold(name.trim())));
  // People and "everyone" are candidates too, so "@Mina Kim" never half-matches a bot called Mina.
  const names = [
    ...bots.map((bot) => ({ bot, key: fold(bot.name.trim()) })),
    ...[...people, ...otherBots, "everyone"].map((name) => ({ bot: null, key: fold(name.trim()) })),
  ].filter(({ key }) => key).sort((a, b) => b.key.length - a.key.length);
  const lower = fold(text);
  let at = -1;
  let tagged = false;
  while ((at = lower.indexOf("@", at + 1)) !== -1) {
    if (at > 0 && !/\s/.test(lower[at - 1]!)) continue;
    const rest = lower.slice(at + 1);
    const hit = names.find(({ key }) => rest.startsWith(key) && !/[a-z0-9]/i.test(rest[key.length] ?? ""));
    if (hit?.bot) return hit.bot;
    if (hit) {
      tagged = true;
      if (otherNames.has(hit.key)) replyToBotId = undefined;
    }
  }
  return bots.find((bot) => bot.id === replyToBotId) ?? (soloWakes && !tagged && bots.length === 1 ? bots[0]! : null);
}

/** A bot's line wakes only the bot it @'s, never itself: a reply or a solo wake would ping-pong between answers. */
export function botLineResponder<T extends { id: string; name: string }>(text: string, bots: readonly T[], people: readonly string[], authorId: string): T | null {
  const author = bots.find((bot) => bot.id === authorId);
  return roomResponder(text, bots.filter((bot) => bot !== author), author ? [...people, author.name] : people, undefined, false);
}
