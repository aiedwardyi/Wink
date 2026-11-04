import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { checkGate, lowerPriority } from "./runtime.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const repo = path.resolve(root, "../..");
const scratch = path.join(process.env.TEMP, "wink-ACCT-TRADER-S");
console.log("Build priority", lowerPriority());
checkGate();
await mkdir(scratch, { recursive: true });
const styles = await readFile(path.join(repo, "src/styles.css"), "utf8");
const themes = ["github-dimmed", "code-review", "terminal"];
const tokens = themes.map((theme) => {
  const match = styles.match(new RegExp(`\\[data-skin="${theme}"\\] \\{[^}]+\\}`));
  if (!match) throw new Error(`Missing skin ${theme}`);
  return match[0];
}).join("\n\n");
await writeFile(path.join(root, "tokens.css"), `/* Skin tokens from src/styles.css at ab89c492. */\n:root { --font-geist: "Geist",; }\n${tokens}\n`);
await build({
  configFile: false, root, publicDir: false,
  plugins: [react(), tailwindcss()],
  resolve: { alias: [
    { find: "@/state/store", replacement: path.join(root, "fixture-store.tsx") },
    { find: "@", replacement: path.join(repo, "src") },
  ] },
  build: {
    outDir: path.join(scratch, "site"), emptyOutDir: false,
    target: "chrome140", modulePreload: { polyfill: false },
    rollupOptions: { input: { concept: path.join(root, "index.html"), today: path.join(root, "today.html") } },
  },
});
await cp(path.join(repo, "public/fonts"), path.join(scratch, "site/fonts"), { recursive: true });
console.log(`Fixture build: ${path.join(scratch, "site")}`);
