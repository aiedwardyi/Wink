// The two deliverable sheets from rendered shots: concept.png (new) and today.png (ab89c492).
//   node sheets.mjs <newShotsDir> <todayShotsDir> <outDir>
// Phone crops come first in every row: phone at 390 is judged first.
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRATCH } from "./serve.mjs";

const [NEW, TODAY, OUT] = process.argv.slice(2);
if (!NEW || !TODAY || !OUT) throw new Error("usage: sheets.mjs <newShotsDir> <todayShotsDir> <outDir>");
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = "Fixtures: Wed Nov 4, 3:12 PM. Claude 1 in use (66% of 5h, 39% of week used), Claude 2 out until Mon 5:00 PM, Claude 3 at 40%. Codex 1 weekly only at 82%, Codex 2 at 40%. Grok no data yet. Gemini.";

const item = (dir, id, label) => {
  const file = join(dir, `${id}.png`);
  if (!existsSync(file)) throw new Error(`missing shot ${file}`);
  return { file, label };
};
const four = (dir, skin, locale, label, chat = "chat + quick view") => ({
  label,
  items: [
    item(dir, `usage-390-${skin}-${locale}`, "Phone 390 · Usage"),
    item(dir, `chat-390-${skin}-${locale}`, `Phone 390 · ${chat}`),
    item(dir, `usage-1280-${skin}-${locale}`, "Desktop 1280 · Usage"),
    item(dir, `chat-1280-${skin}-${locale}`, `Desktop 1280 · ${chat}`),
  ],
});

const sheets = {
  concept: {
    title: "Race to reset · concept (ACCT-TRADER-O)",
    note: FIXTURE,
    rows: [
      four(NEW, "github-dimmed", "en", "GitHub Dimmed · en"),
      four(NEW, "ledger", "en", "Ledger (light) · en"),
      four(NEW, "terminal", "en", "Terminal · en"),
      four(NEW, "github-dimmed", "ko", "GitHub Dimmed · ko"),
      {
        label: "More places · GitHub Dimmed · en",
        items: [
          item(NEW, "wait-390-github-dimmed-en", "Phone 390 · usage wait card"),
          item(NEW, "conn-390-github-dimmed-en", "Phone 390 · Connections"),
          item(NEW, "codex-390-github-dimmed-en", "Phone 390 · Codex runs out"),
          item(NEW, "wait-1280-github-dimmed-en", "Desktop 1280 · usage wait card"),
          item(NEW, "conn-1280-github-dimmed-en", "Desktop 1280 · Connections"),
        ],
      },
    ],
  },
  today: {
    title: "Today · real components at ab89c492",
    note: FIXTURE,
    rows: [
      four(TODAY, "github-dimmed", "en", "GitHub Dimmed · en", "chat meter"),
      four(TODAY, "terminal", "en", "Terminal · en", "chat meter"),
      {
        label: "More places · GitHub Dimmed · en",
        items: [
          item(TODAY, "wait-390-github-dimmed-en", "Phone 390 · usage wait card"),
          item(TODAY, "conn-390-github-dimmed-en", "Phone 390 · Connections"),
          item(TODAY, "wait-1280-github-dimmed-en", "Desktop 1280 · usage wait card"),
          item(TODAY, "conn-1280-github-dimmed-en", "Desktop 1280 · Connections"),
        ],
      },
    ],
  },
};

for (const [name, spec] of Object.entries(sheets)) {
  const specFile = join(SCRATCH, `sheet-${name}.json`);
  writeFileSync(specFile, JSON.stringify(spec, null, 1));
  const run = spawnSync("python", ["-I", join(HERE, "sheet.py"), specFile, join(OUT, `${name}.png`)], { windowsHide: true, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`sheet ${name}: ${run.stderr || run.error}`);
  process.stdout.write(run.stdout);
}
