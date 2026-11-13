// Six hues per skin, clear of red/green (diff, pass/fail) and amber (clash); the 7th worker on is gray. Hues live in MapPane.css.
export const MAP_WORKER_HUES = 6;

export function mapWorkerSlots(slots: ReadonlyMap<string, number>, ids: readonly string[]): ReadonlyMap<string, number> {
  if (ids.every(id => slots.has(id))) return slots;
  const next = new Map(slots);
  for (const id of ids) if (!next.has(id)) next.set(id, next.size < MAP_WORKER_HUES ? next.size + 1 : 0);
  return next;
}

export const mapWorkerColor = (slot: number | undefined) => `var(--map-w${slot ?? 0})`;
