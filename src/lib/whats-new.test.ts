import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { newerRelease } from "../../shared/release-order";
import { clipFacts } from "./testing/whats-new-clips";
import { tilesOnly, unseenRelease, WHATS_NEW, type WhatsNewEntry } from "./whats-new";

describe("unseen release notes", () => {
  it("shows the notes a skipped release carried", () => {
    expect(unseenRelease("1.0.247", "1.0.245")).toBe("1.0.246");
    expect(unseenRelease("1.0.248", "1.0.245", ["1.0.246"])).toBe("1.0.246");
  });

  it("shows them on an install with no record", () => {
    expect(unseenRelease("1.0.248", null, ["1.0.246"])).toBe("1.0.246");
  });

  it("shows nothing once they were seen, on this release or a later one without notes", () => {
    expect(unseenRelease("1.0.247", "1.0.246", ["1.0.246"])).toBeNull();
    expect(unseenRelease("1.0.248", "1.0.246", ["1.0.246"])).toBeNull();
    expect(unseenRelease("1.0.248", "1.0.247", ["1.0.246"])).toBeNull();
  });

  it("shows only the newest of two unseen", () => {
    expect(unseenRelease("1.0.249", "1.0.245", ["1.0.246", "1.0.248"])).toBe("1.0.248");
    expect(unseenRelease("1.0.249", "1.0.245", ["1.0.248", "1.0.246"])).toBe("1.0.248");
    expect(unseenRelease("1.0.249", "1.0.246", ["1.0.246", "1.0.248"])).toBe("1.0.248");
  });

  it("never shows notes newer than the running release", () => {
    expect(unseenRelease("1.0.248", "1.0.245", ["1.0.246", "1.0.250"])).toBe("1.0.246");
    expect(unseenRelease("1.0.245", null, ["1.0.246"])).toBeNull();
  });

  it("orders releases by number, not text", () => {
    expect(unseenRelease("1.0.100", "1.0.98", ["1.0.99", "1.0.100"])).toBe("1.0.100");
    expect(unseenRelease("1.1.0", "1.0.99", ["1.0.100"])).toBe("1.0.100");
  });
});

it("calls a worker 작업자 in Korean, as the rest of the app does", () => {
  expect(JSON.stringify(WHATS_NEW["1.0.263"])).not.toContain("워커");
  expect(WHATS_NEW["1.0.263"].tiles[0].title.ko).toContain("작업자");
});

const ENFORCE_AFTER = "1.0.278";

function stale(entries: Record<string, WhatsNewEntry>): string[] {
  const found: string[] = [];
  for (const [version, entry] of Object.entries(entries)) {
    if (!newerRelease(version, ENFORCE_AFTER)) continue;
    for (const tile of entry.tiles) {
      const clips = [tile.clip, tile.lightClip].filter((clip): clip is string => Boolean(clip));
      const why = [
        tile.still && "is marked still",
        !("show" in tile && tile.show) && "has no show target",
        ...clips.map((clip) => {
          const facts = clipFacts(join(".", clip));
          return facts === null ? `${clip} is not a WebP or MP4` : facts.durations.length < 2 ? `${clip} is not animated` : null;
        }),
      ].filter(Boolean);
      if (why.length) found.push(`What's New tile ${version} needs a moving clip and a show target that opens the feature (see WhatsNewTile in src/lib/whats-new.ts): "${tile.title.en}" ${why.join(", ")}`);
    }
  }
  return found;
}

describe("what's new tiles", () => {
  it("ships every tile after 1.0.278 as a moving clip with a Show me that opens the feature", () => {
    expect(stale(WHATS_NEW)).toEqual([]);
  });

  const copy = { en: "x", ko: "x" };
  const moving = "src/assets/whats-new/1.0.276-themes.webp";
  const still = "src/assets/whats-new/1.0.277-dial.webp";
  const entry = (tile: object): Record<string, WhatsNewEntry> => ({ "1.0.279": { title: copy, more: copy, tiles: [{ title: copy, line: copy, ...tile } as WhatsNewEntry["tiles"][0]] } });

  it.each([
    ["a still clip", { clip: still, show: "memory" }, "is not animated"],
    ["a clip marked still", { clip: moving, still: true, show: "memory" }, "is marked still"],
    ["a text line in place of a target", { clip: moving, how: copy }, "has no show target"],
    ["a clip that is not a WebP", { clip: "package.json", show: "memory" }, "is not a WebP"],
  ])("flags %s", (_name, tile, why) => {
    expect(stale(entry(tile))).toEqual([expect.stringContaining(why)]);
  });

  it("passes a moving clip that opens a target", () => {
    expect(stale(entry({ clip: moving, show: "workers" }))).toEqual([]);
  });

  it("leaves tiles up to 1.0.278 as they shipped", () => {
    expect(stale({ "1.0.246": WHATS_NEW["1.0.246"], "1.0.277": WHATS_NEW["1.0.277"], "1.0.278": entry({ clip: still, show: "memory" })["1.0.279"] })).toEqual([]);
    expect(stale({ "1.0.246": WHATS_NEW["1.0.246"], ...entry({ clip: still, show: "memory" }) })).toHaveLength(1);
  });

  it("keeps a no-tile record out of the cards", () => {
    const quiet = { tile: "none", reason: "Quiet release." } as const;
    const kept = tilesOnly({ "1.0.278": WHATS_NEW["1.0.278"], "1.0.279": quiet });
    expect(Object.keys(kept)).toEqual(["1.0.278"]);
    expect(unseenRelease("1.0.279", "1.0.277", Object.keys(kept))).toBe("1.0.278");
  });

  it("passes a release that adds no tile", () => {
    expect(stale({})).toEqual([]);
    expect(stale({ "1.0.278": WHATS_NEW["1.0.278"] })).toEqual([]);
    expect(stale({ "1.0.279": { title: copy, more: copy, tiles: [] as unknown as WhatsNewEntry["tiles"] } })).toEqual([]);
  });
});
