import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export async function loadTerminalBridgeToken(profile) {
  await fs.mkdir(profile, { recursive: true, mode: 0o700 });
  const file = path.join(profile, "terminal-bridge-token");
  const read = () => fs.readFile(file, "utf8").then(text => /^[a-f0-9]{48}$/.test(text.trim()) ? text.trim() : null).catch(() => null);
  const existing = await read();
  if (existing) return existing;
  const token = randomBytes(24).toString("hex");
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, token, { flag: "wx", mode: 0o600 });
    await fs.link(tmp, file);
  }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const current = await read();
    if (!current) throw new Error("Invalid terminal bridge identity");
    return current;
  } finally { await fs.rm(tmp, { force: true }); }
  return token;
}

export async function publishTerminalDiscovery(profile, access, mailboxUrl) {
  const file = path.join(profile, "terminal-discovery.json");
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.mkdir(profile, { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(tmp, JSON.stringify({ url: access.url, mailboxUrl }), { mode: 0o600 });
    await fs.rename(tmp, file);
  } finally { await fs.rm(tmp, { force: true }); }
}
