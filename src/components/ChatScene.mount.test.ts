import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = readdirSync(src, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".tsx") && !file.endsWith(".test.tsx"))
  .map((file) => ({ file: relative(src, join(src, file)).replaceAll("\\", "/"), code: readFileSync(join(src, file), "utf8") }));
const renders = (code: string, name: string) => new RegExp(`<${name}[\\s/>]`).test(code);

// A view is a file with a <main> that renders the composer, itself or through a wrapper like TeamRoomComposer.
function chatViews() {
  const composers = new Set(["Composer"]);
  const views = new Set<(typeof files)[number]>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const entry of files) {
      if (views.has(entry) || ![...composers].some((name) => renders(entry.code, name))) continue;
      if (/<main[\s>]/.test(entry.code)) {
        views.add(entry);
        continue;
      }
      for (const [, name] of entry.code.matchAll(/export function ([A-Z]\w*)/g)) {
        if (composers.has(name)) continue;
        composers.add(name);
        grew = true;
      }
    }
  }
  return [...views];
}

describe("every chat surface mounts the scene", () => {
  const views = chatViews();

  it("finds the chat views", () => {
    expect(views.map(({ file }) => file)).toEqual(expect.arrayContaining(["components/ChatView.tsx", "components/GroupView.tsx", "components/JoinedRoomView.tsx", "components/TeamRoomView.tsx"]));
  });

  it.each(views.map(({ file, code }) => [file, code]))("%s", (file, code) => {
    const missing = [!renders(code, "ChatScene") && "<ChatScene>", !/<main[^>]*\sdata-scene=\{scene\}/.test(code) && "data-scene={scene} on its <main>"].filter(Boolean);
    expect(missing, `${file} renders a composer but not ${missing.join(" or ")}. Mount it like ChatView: const scene = sceneOf(useSkin()), <main data-scene={scene}>, {scene && <ChatScene ... />} first inside it, and call its sendRef from the composer's onSend.`).toEqual([]);
  });
});
