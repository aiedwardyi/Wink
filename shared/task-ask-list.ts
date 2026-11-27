/** A copied ask keeps the newest record's status, including closed status. */
export function latestTaskAsks<T extends { at: number }>(
  records: readonly { updatedAt?: number; asks?: readonly T[] }[],
  text: (ask: T) => string,
): T[] {
  const asks = new Map<string, T>();
  for (const record of [...records].sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0))) {
    for (const ask of record.asks ?? []) asks.set(`${ask.at}\0${text(ask)}`, ask);
  }
  return [...asks.values()].sort((a, b) => a.at - b.at);
}
