// [dark skins, light skins]; clear of red/green (diff, CI) and amber (clash), color-blind checked on Wink and Atelier.
const HUES = [["#929fff", "#374ca6"], ["#b26e25", "#b26d07"], ["#2fa290", "#059579"], ["#1885d0", "#3982d2"], ["#91669f", "#652d6e"], ["#23cce6", "#057189"]];
const GRAY = ["#80848f", "#8c8476"];

export function mapWorkerSlots(slots: ReadonlyMap<string, number>, ids: readonly string[]): ReadonlyMap<string, number> {
  const added = ids.filter(id => !slots.has(id));
  if (!added.length) return slots;
  const next = new Map(slots);
  for (const id of added) next.set(id, next.size);
  return next;
}

export function mapWorkerColor(slot: number) {
  const [dark, light] = HUES[slot] ?? GRAY;
  return `light-dark(${light}, ${dark})`;
}
