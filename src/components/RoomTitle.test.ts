import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const title = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "RoomTitle.tsx"), "utf8");

describe("room title", () => {
  it("gives the title a 44px touch target without growing the header", () => {
    expect(title).toContain("py-0.5 pointer-coarse:-my-2.5 pointer-coarse:py-3");
  });
});
