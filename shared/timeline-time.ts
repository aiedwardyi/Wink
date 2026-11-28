const pad = (value: number) => String(value).padStart(2, "0");

export function pickStamp(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function entryTime({ id, at, binding }: { id: string; at?: number; binding?: "verified" | "unbound" }): number {
  const stamp = id.replace(/ \(\d+\)$/, "");
  // a text-only pick sorts by its day alone: its minute was never proven
  if (binding === "unbound") return new Date(`${stamp.slice(0, 10)}T00:00`).getTime();
  if (at !== undefined) return at;
  return new Date(stamp.includes(" ") ? stamp.replace(" ", "T") : `${stamp}T00:00`).getTime();
}
