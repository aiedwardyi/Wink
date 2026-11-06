export const REPLAY_LIMIT = 3 * 1024 * 1024;

export function chunk(kind, value) {
  let payload;
  if (kind === 1) {
    payload = Buffer.allocUnsafe(5 + value.data.length);
    payload[0] = value.tile === "desktop" ? 0 : 1;
    payload.writeUInt32LE(Math.max(0, Math.min(0xffffffff, Math.round(value.ms))), 1);
    value.data.copy(payload, 5);
  } else payload = Buffer.from(JSON.stringify(value));
  const bytes = Buffer.allocUnsafe(5 + payload.length);
  bytes.writeUInt32LE(1 + payload.length);
  bytes[4] = kind;
  payload.copy(bytes, 5);
  return bytes;
}

export function decodeChunks(onChunk) {
  let pending = Buffer.alloc(0);
  return {
    push(bytes) {
      let offset = 0;
      while (offset < bytes.length) {
        const need = pending.length < 4 ? 4 : pending.readUInt32LE(0) + 4;
        const take = Math.min(need - pending.length, bytes.length - offset);
        pending = Buffer.concat([pending, bytes.subarray(offset, offset + take)]);
        offset += take;
        if (pending.length < 4) continue;
        const length = pending.readUInt32LE(0);
        if (length < 1 || length > REPLAY_LIMIT) throw new Error("Invalid replay chunk size");
        if (pending.length < length + 4) continue;
        const raw = pending, kind = raw[4], payload = raw.subarray(5);
        pending = Buffer.alloc(0);
        if (kind > 3 || kind === 1 && (payload.length < 6 || payload[0] > 1)) throw new Error("Invalid replay chunk");
        const value = kind === 1 ? { tile: payload[0] === 0 ? "desktop" : "phone", ms: payload.readUInt32LE(1), data: payload.subarray(5) } : JSON.parse(payload.toString("utf8"));
        onChunk({ ...value, kind, value, raw });
      }
    },
    end() { if (pending.length) throw new Error("Incomplete replay chunk"); },
  };
}
