import { inflateSync } from "node:zlib";

export function safeImageMetadata(bytes: Buffer, mime: string, scrub: (text: string) => string): boolean {
  // Compressed pixels stay opaque to text filters.
  const safe = (data: Buffer) => { const text = data.toString("latin1"); return scrub(text) === text; };
  try {
    if (mime === "image/png") {
      for (let offset = 8; offset + 12 <= bytes.length;) {
        const size = bytes.readUInt32BE(offset), type = bytes.toString("ascii", offset + 4, offset + 8);
        const end = offset + 8 + size;
        if (end + 4 > bytes.length) return false;
        const data = bytes.subarray(offset + 8, end);
        if (["tEXt", "eXIf"].includes(type) && !safe(data)) return false;
        if (type === "zTXt" || type === "iTXt") {
          const keyword = data.indexOf(0);
          if (keyword < 0) return false;
          if (type === "zTXt") {
            if (!safe(data.subarray(0, keyword)) || !safe(inflateSync(data.subarray(keyword + 2), { maxOutputLength: 1024 * 1024 }))) return false;
          } else {
            const language = data.indexOf(0, keyword + 3), translated = data.indexOf(0, language + 1);
            if (language < 0 || translated < 0 || !safe(data.subarray(0, translated))) return false;
            const text = data.subarray(translated + 1);
            if (!safe(data[keyword + 1] ? inflateSync(text, { maxOutputLength: 1024 * 1024 }) : text)) return false;
          }
        }
        offset = end + 4;
        if (type === "IEND") return safe(bytes.subarray(offset));
      }
    } else if (mime === "image/jpeg") {
      for (let offset = 2; offset + 1 < bytes.length;) {
        if (bytes[offset++] !== 0xff) return false;
        while (bytes[offset] === 0xff) offset++;
        const marker = bytes[offset++]!;
        if (marker === 0xd9) return true;
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        const size = bytes.readUInt16BE(offset);
        if (size < 2 || offset + size > bytes.length) return false;
        if ((marker >= 0xe0 || marker === 0xfe) && !safe(bytes.subarray(offset + 2, offset + size))) return false;
        offset += size;
        if (marker === 0xda) {
          while (offset < bytes.length) {
            offset = bytes.indexOf(0xff, offset);
            if (offset < 0) return false;
            const start = offset++;
            while (bytes[offset] === 0xff) offset++;
            const next = bytes[offset++]!;
            if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) continue;
            offset = start;
            break;
          }
        }
      }
      return false;
    } else if (mime === "image/webp") {
      for (let offset = 12; offset + 8 <= bytes.length;) {
        const type = bytes.toString("ascii", offset, offset + 4), size = bytes.readUInt32LE(offset + 4);
        if (offset + 8 + size > bytes.length) return false;
        if (["EXIF", "XMP "].includes(type) && !safe(bytes.subarray(offset + 8, offset + 8 + size))) return false;
        offset += 8 + size + (size % 2);
      }
    } else if (mime === "image/gif") {
      let offset = 13 + (bytes[10]! & 0x80 ? 3 * (1 << ((bytes[10]! & 7) + 1)) : 0);
      while (offset < bytes.length) {
        const marker = bytes[offset++];
        if (marker === 0x3b) break;
        let metadata = false;
        if (marker === 0x21) metadata = [0xfe, 0xff, 0x01].includes(bytes[offset++]!);
        else if (marker === 0x2c) {
          const packed = bytes[offset + 8]!;
          offset += 10 + (packed & 0x80 ? 3 * (1 << ((packed & 7) + 1)) : 0);
        } else return false;
        const parts: Buffer[] = [];
        while (bytes[offset]) {
          const size = bytes[offset++]!;
          if (offset + size > bytes.length) return false;
          if (metadata) parts.push(bytes.subarray(offset, offset + size));
          offset += size;
        }
        offset++;
        if (metadata && !safe(Buffer.concat(parts))) return false;
      }
    }
    return true;
  } catch { return false; }
}
