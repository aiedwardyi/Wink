// [dark skins, light skins]; clear of red/green (diff, CI) and amber (clash), color-blind checked on Wink and Atelier.
const HUES = [["#929fff", "#374ca6"], ["#b26e25", "#b26d07"], ["#2fa290", "#059579"], ["#1885d0", "#3982d2"], ["#91669f", "#652d6e"], ["#23cce6", "#057189"]];
const GRAY = ["#80848f", "#8c8476"];

export function mapWorkerSlots(slots: ReadonlyMap<string, number>, ids: readonly string[]): ReadonlyMap<string, number> {
  const live = new Set(ids);
  const next = new Map([...slots].filter(([id, slot]) => live.has(id) && slot < HUES.length));
  const used = new Set(next.values());
  let free = 0;
  for (const id of [...slots.keys(), ...ids]) if (live.has(id) && !next.has(id)) {
    while (used.has(free)) free++;
    next.set(id, free); used.add(free);
  }
  return next.size === slots.size && [...next].every(([id, slot]) => slots.get(id) === slot) ? slots : next;
}

export function mapWorkerColor(slot: number) {
  const [dark, light] = HUES[slot] ?? GRAY;
  return `light-dark(${light}, ${dark})`;
}
