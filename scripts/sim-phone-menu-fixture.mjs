import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const links = ["#hours", "#contact"];
export const request = "Fix the broken mobile menu in index.html so Hours and Contact open at 392 px.";

export function writePhoneMenuFixture(project, fixed) {
  mkdirSync(project, { recursive: true });
  const nav = '<nav aria-label="Main"><a href="#hours">Hours</a><a href="#contact">Contact</a></nav>';
  writeFileSync(join(project, "index.html"), `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Corner Library</title>
  <style>
    body { font: 18px system-ui; margin: 20px; }
    a, summary { display: inline-block; padding: 12px; }
    details { display: none; }
    @media (max-width: 500px) {
      header > nav { display: none; }
      details { display: block; }
    }
  </style>
</head>
<body>
  <header>${nav}${fixed ? `<details><summary>Menu</summary>${nav}</details>` : ""}</header>
  <main><h1>Corner Library</h1><h2 id="hours">Hours</h2><p>Open at 10.</p><h2 id="contact">Contact</h2><p>Visit the front desk.</p></main>
</body>
</html>
`);
}

export async function menuOpens(page, url) {
  await page.goto(url);
  const width = await page.evaluate(() => innerWidth);
  if (width !== 392) throw new Error(`Expected 392 px, got ${width}`);
  const button = page.getByText("Menu", { exact: true });
  if (await button.count() !== 1) return false;
  await button.click();
  for (const href of links) {
    if (await page.locator(`header a[href="${href}"]:visible`).count() !== 1) return false;
  }
  return true;
}
