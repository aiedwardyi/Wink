import { readFileSync, writeFileSync } from "node:fs";
// Red recipe: the second send waits until the first prompt reached the engine, so it lands as a steer on the hung prompt.
const file = "server/branching.test.ts";
const anchor = '      const parallel = await api("POST", `/api/bots/${created.id}/messages`, { text: "sneaky second" });';
const src = readFileSync(file, "utf8");
if (!src.includes(anchor)) throw new Error("anchor missing");
const wait = '      await waitFor(async () => { try { return readFileSync(fakeHangDump, "utf8").includes("first try"); } catch { return false; } }, "RED: first prompt reached the engine");';
writeFileSync(file, src.replace(anchor, wait + "\n" + anchor));
