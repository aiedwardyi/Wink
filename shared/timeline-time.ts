const pad = (value: number) => String(value).padStart(2, "0");

export function pickStamp(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function entryTime({ id, at, binding }: { id: string; at?: number; binding?: "verified" | "unbound" }): number {
  if (binding === "unbound") return -Infinity;
  if (at !== undefined) return at;
  const stamp = id.replace(/ \(\d+\)$/, "");
  return new Date(stamp.includes(" ") ? stamp.replace(" ", "T") : `${stamp}T00:00`).getTime();
}
