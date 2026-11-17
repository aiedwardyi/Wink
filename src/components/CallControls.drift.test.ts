import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = join(dirname(fileURLToPath(import.meta.url)), "..");
const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  if (entry.isDirectory()) return sources(path);
  return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
});
const files = sources(src).map((path) => ({ file: relative(src, path).replaceAll("\\", "/"), text: readFileSync(path, "utf8") }));
const having = (pattern: RegExp) => files.filter(({ text }) => pattern.test(text)).map(({ file }) => file).sort();

describe("one call path for 1:1 chats and team rooms", () => {
  it("builds the call controller in one place", () => {
    expect(having(/new LiveCall\(/), "start a call through placeCall; LiveCallHost owns the one LiveCall").toEqual(["components/LiveCallBar.tsx"]);
  });

  it("mounts the call bar and call box only through useCallControls", () => {
    expect(having(/<LiveCallBar\b|<LiveCallBox\b|m\.LiveCallBar\b|m\.LiveCallBox\b/), "render the call with useCallControls(bot, hidden, room?), never a room-only copy").toEqual(["components/CallControls.tsx"]);
  });

  it.each(["components/ChatView.tsx", "components/TeamRoomView.tsx", "components/JoinedRoomView.tsx"])("%s gets its call from useCallControls", (file) => {
    const text = files.find((entry) => entry.file === file)!.text;
    expect(text).toMatch(/\buseCallControls\(/);
    expect(text, "a view never places or builds a call itself").not.toMatch(/\bplaceCall\(|from "@\/lib\/live-call\/controller"/);
  });
});
