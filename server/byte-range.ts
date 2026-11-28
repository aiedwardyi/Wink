export function byteRange(header: string | undefined, size: number): { start: number; end: number } | "all" | "bad" {
  if (!header) return "all";
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || size <= 0) return "bad";
  let start: number;
  let end: number;
  if (match[1] === "" && match[2] !== "") {
    const suffix = Number(match[2]);
    if (!Number.isInteger(suffix) || suffix <= 0) return "bad";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else if (match[1] !== "") {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
  } else return "bad";
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) return "bad";
  return { start, end: Math.min(end, size - 1) };
}
