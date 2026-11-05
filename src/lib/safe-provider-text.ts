const EMAIL = /[^\s@<>()[\]",;:]+@[^\s@<>()[\]"',;:]+\.[^\s@<>()[\]"',;:]+/g;
const CAP = 280;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Provider text cleaned for any surface outside Connections rows: no email shape, no part of a known account identity, capped. */
export function safeProviderText(text: string, identities: readonly (string | null | undefined)[]): string {
  const parts = new Set<string>();
  for (const identity of identities) {
    const value = identity?.trim();
    if (!value) continue;
    parts.add(value);
    const at = value.lastIndexOf("@");
    if (at > 0) {
      parts.add(value.slice(0, at));
      parts.add(value.slice(at + 1));
    }
  }
  let safe = text.replace(EMAIL, "…");
  for (const part of [...parts].sort((a, b) => b.length - a.length)) {
    if (part.length < 3) continue;
    safe = safe.replace(new RegExp(escape(part), "gi"), "…");
  }
  safe = safe.replace(/\s+/g, " ").trim();
  return safe.length > CAP ? `${safe.slice(0, CAP - 1).trimEnd()}…` : safe;
}
