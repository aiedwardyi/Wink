// Team room names: unique per room across the host, its bots and people.

export const NAME_MAX = 40;

/** The comparison form: NFC, then case-folded. */
export const nameKey = (name: string) => name.normalize("NFC").toLowerCase();

/** The stored form, or why it can't be one. */
export function checkedRoomName(value: unknown, taken: readonly string[]): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof value !== "string") return { ok: false, error: "name must be text" };
  const name = value.normalize("NFC").trim();
  if (!name || [...name].length > NAME_MAX) return { ok: false, error: `name must be 1-${NAME_MAX} characters` };
  if (/[@\r\n]/.test(name)) return { ok: false, error: "name can't contain @ or a line break" };
  const key = nameKey(name);
  if (key === "everyone") return { ok: false, error: "that name is reserved" };
  if (taken.some((other) => nameKey(other) === key)) return { ok: false, error: "someone in this room already has that name" };
  return { ok: true, name };
}

/** The first name in `names` that collides with another in it or in `taken`. */
export function nameClash(names: readonly string[], taken: readonly string[] = []): string | null {
  const seen = new Set(taken.map(nameKey));
  for (const name of names) {
    const key = nameKey(name.normalize("NFC").trim());
    if (seen.has(key)) return name;
    seen.add(key);
  }
  return null;
}
