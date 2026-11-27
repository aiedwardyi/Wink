import { describe, expect, it } from "vitest";
import { checkGeminiLinks, geminiLinkHits } from "./check-gemini-links.mjs";

const file = "server/drivers/fixture.ts";
const gemini = 'const source = join(home, ".gemini");\n';

describe("Gemini link gate", () => {
  it.each([
    'import { symlinkSync } from "node:fs";\nsymlinkSync(source, to, "junction");',
    'import { linkSync as hard } from "fs";\nhard(source, to);',
    'import * as fs from "node:fs";\nfs.symlinkSync(source, to);',
    'import fs from "node:fs";\nawait fs.promises.symlink(source, to, "junction");',
    'import { symlink } from "node:fs/promises";\nawait symlink(source, to);',
  ])("rejects a link in code that handles the Gemini home: %s", (source) => {
    expect(geminiLinkHits(file, gemini + source)).toHaveLength(1);
  });

  it.each([
    'import { copyFileSync } from "node:fs";\ncopyFileSync(source, to);',
    'import { writeFileAtomic } from "../atomic.ts";\nwriteFileAtomic(to, "{}");',
    'const link = (a, b) => a + b;\nlink(source, to);',
  ])("accepts code that makes no fs link: %s", (source) => {
    expect(geminiLinkHits(file, gemini + source)).toEqual([]);
  });

  it("leaves code that never handles the Gemini home to its own rules", () => {
    expect(geminiLinkHits(file, 'import { symlinkSync } from "node:fs";\nsymlinkSync(skills, to, "junction");')).toEqual([]);
  });

  it("lets a listed file keep only its counted links", () => {
    const source = `${gemini}import { linkSync } from "node:fs";\nlinkSync(temp, record);\nlinkSync(source, to);`;
    expect(checkGeminiLinks([file], () => source, { [file]: 1 })).toHaveLength(1);
    expect(checkGeminiLinks([file], () => source, { [file]: 2 })).toEqual([]);
  });

  it("names the fix", () => {
    const [hit] = checkGeminiLinks([file], () => `${gemini}import { symlinkSync } from "node:fs";\nsymlinkSync(source, to);`);
    expect(hit).toMatch(/^server\/drivers\/fixture\.ts:3: .*antigravity-home\.ts/);
  });
});
