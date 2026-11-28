import { readFileSync } from "node:fs";

function mp4Box(data: Buffer, path: string[]): Buffer | null {
  for (let at = 0; at + 8 <= data.length; ) {
    const size = data.readUInt32BE(at);
    if (size < 8) return null;
    if (data.toString("latin1", at + 4, at + 8) === path[0]) {
      const body = data.subarray(at + 8, at + size);
      return path.length === 1 ? body : mp4Box(body, path.slice(1));
    }
    at += size;
  }
  return null;
}

const STBL = ["moov", "trak", "mdia", "minf", "stbl"];

/** A WebP or MP4 clip: source width and each frame's duration in ms (none for a still WebP); null for any other file. */
export function clipFacts(path: string): { width: number; durations: number[] } | null {
  const data = readFileSync(path);
  if (data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP") {
    const durations: number[] = [];
    let width = 0;
    for (let at = 12; at + 8 <= data.length; ) {
      const size = data.readUInt32LE(at + 4);
      const kind = data.toString("latin1", at, at + 4);
      if (kind === "VP8X") width = data.readUIntLE(at + 12, 3) + 1;
      if (kind === "ANMF" && at + 23 <= data.length) durations.push(data.readUIntLE(at + 20, 3));
      at += 8 + size + (size % 2);
    }
    return { width, durations };
  }
  if (data.toString("latin1", 4, 8) !== "ftyp") return null;
  const mdhd = mp4Box(data, ["moov", "trak", "mdia", "mdhd"]);
  const stts = mp4Box(data, [...STBL, "stts"]);
  const stsd = mp4Box(data, [...STBL, "stsd"]);
  if (!mdhd || !stts || !stsd) return null;
  const timescale = mdhd.readUInt32BE(mdhd[0] === 1 ? 20 : 12);
  const durations: number[] = [];
  for (let entry = 0; entry < stts.readUInt32BE(4); entry++) {
    const count = stts.readUInt32BE(8 + entry * 8);
    const delta = stts.readUInt32BE(12 + entry * 8);
    for (let i = 0; i < count; i++) durations.push((delta * 1000) / timescale);
  }
  return { width: stsd.readUInt16BE(40), durations };
}
