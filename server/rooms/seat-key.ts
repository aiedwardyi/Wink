// A team room's code for the user's other PCs, sealed in the sync folder. Each PC
// keeps an X25519 key of its own and publishes only its public half; the host
// seals the room code to it, so what the folder holds opens nothing by itself.
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "../atomic.ts";

const KEY_FILE = "room-seat-key.json";
const INFO = "wink room seat v1";
const PUBLIC = /^[A-Za-z0-9_-]{43}$/;
const SEALED = /^v1\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{24,700})$/;
const CODE_ID = /^wkr1:[a-z0-9.-]+:([\w-]+)\./;
export const OWNER_SEAT_PREFIX = "seat_";
export const isOwnerRoomCode = (code?: string | null): boolean => CODE_ID.exec(code ?? "")?.[1]?.startsWith(OWNER_SEAT_PREFIX) === true;

export const isSeatKey = (value: unknown): value is string => typeof value === "string" && PUBLIC.test(value);

const publicKeyOf = (x: string) => createPublicKey({ key: { kty: "OKP", crv: "X25519", x }, format: "jwk" });
const rawOf = (key: KeyObject) => String(key.export({ format: "jwk" }).x);

/** This PC's key, made on first use and never written anywhere but its data dir. */
function own(dataDir: string): { publicKey: string; privateKey: KeyObject } {
  const file = join(dataDir, KEY_FILE);
  try {
    const { d, x } = JSON.parse(readFileSync(file, "utf8")) as { d: unknown; x: unknown };
    if (typeof d === "string" && isSeatKey(x)) return { publicKey: x, privateKey: createPrivateKey({ key: { kty: "OKP", crv: "X25519", d, x }, format: "jwk" }) };
  } catch {}
  const { privateKey } = generateKeyPairSync("x25519");
  const { d, x } = privateKey.export({ format: "jwk" });
  writeFileAtomic(file, JSON.stringify({ d, x }), { mode: 0o600 });
  return { publicKey: String(x), privateKey };
}

export const seatKey = (dataDir: string): string => own(dataDir).publicKey;

function cipherKey(shared: Buffer, ephemeral: string, recipient: string, context: string): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, Buffer.from(`${ephemeral}.${recipient}`), Buffer.from(`${INFO}\n${context}`), 32));
}

/** `text` for the holder of `recipient` alone; `context` binds it to one room pointer. */
export function sealSeat(recipient: string, text: string, context: string): string {
  const ephemeral = generateKeyPairSync("x25519");
  const from = rawOf(ephemeral.publicKey);
  const key = cipherKey(diffieHellman({ privateKey: ephemeral.privateKey, publicKey: publicKeyOf(recipient) }), from, recipient, context);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `v1.${from}.${iv.toString("base64url")}.${body.toString("base64url")}`;
}

/** The text sealed to this PC's key for `context`, or null for any other seal. */
export function openSeat(dataDir: string, sealed: unknown, context: string): string | null {
  const parts = typeof sealed === "string" ? SEALED.exec(sealed) : null;
  if (!parts) return null;
  try {
    const { publicKey, privateKey } = own(dataDir);
    const key = cipherKey(diffieHellman({ privateKey, publicKey: publicKeyOf(parts[1]!) }), parts[1]!, publicKey, context);
    const body = Buffer.from(parts[3]!, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[2]!, "base64url"));
    decipher.setAuthTag(body.subarray(-16));
    return Buffer.concat([decipher.update(body.subarray(0, -16)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
