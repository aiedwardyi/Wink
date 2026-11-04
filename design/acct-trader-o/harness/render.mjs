// Design stills for ACCT-TRADER-O: today's real components, or the concept swapped in, same fixtures.
//   node --require ./guard.cjs --max-old-space-size=2048 render.mjs <today|new> <shot,shot,...> [outDir]
// shot = <place>-<width>-<skin>-<locale>; place: usage | week | codex | chat | conn | wait.
// One browser, one page at a time, each PNG written as it is taken; stops if HEAVY.lock appears.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCRATCH, gateHeld, openList, openPage, openSettings, ram, scan, startApp } from "./serve.mjs";

const [variant = "new", list = "", outArg] = process.argv.slice(2);
const OUT = outArg ?? join(SCRATCH, "shots", variant);
if (gateHeld()) {
  console.log(`timing gate holds HEAVY.lock (${gateHeld()}): holding`);
  process.exit(3);
}
ram("start");
mkdirSync(OUT, { recursive: true });

async function scene(page, place, opts) {
  if (place === "usage" || place === "week" || place === "codex") {
    await openSettings(page, opts, "usage");
    if (variant === "new" && place === "week") await page.getByRole("radio", { name: opts.locale === "ko" ? "주간" : "Week", exact: true }).first().click();
    if (variant === "new" && place === "codex") await page.getByRole("tab", { name: /^Codex/ }).first().click();
  } else if (place === "conn") {
    await openSettings(page, opts, "connections");
  } else if (place === "wait") {
    if (opts.phone) await openList(page, opts.locale);
    await page.getByRole("button", { name: /^Lyra/ }).first().click();
  } else if (place === "chat" && variant === "new") {
    // The way a user opens it: a tap on the chat ticker (phone), Alt+U (desktop).
    await page.locator("[data-desk-ticker]").first().waitFor();
    if (opts.phone) await page.getByRole("button", { name: opts.locale === "ko" ? /^사용량: / : /^Usage: / }).first().tap();
    else await page.keyboard.press("Alt+KeyU");
    await page.locator("[data-desk-quick]").first().waitFor();
  }
}

const app = await startApp(variant);
const result = { variant, shots: {}, errors: [], freeGB: [] };
try {
  for (const id of list.split(",").filter(Boolean)) {
    if (gateHeld()) {
      result.errors.push(`${id}: a timing gate took HEAVY.lock, stopped here`);
      break;
    }
    result.freeGB.push(ram(id));
    const [place, width, ...rest] = id.split("-");
    const locale = rest.at(-1);
    const skin = rest.slice(0, -1).join("-");
    const phone = width === "390";
    let opened;
    try {
      opened = await openPage(app, { width: Number(width), phone, locale, skin });
      const { page } = opened;
      page.on("pageerror", (error) => result.errors.push(`${id}: ${error.message.split("\n")[0]}`));
      await scene(page, place, { phone, locale });
      // Park the pointer on the title strip so no hover state lands in the still.
      if (!phone) await page.mouse.move(640, 4);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(800);
      const file = join(OUT, `${id}.png`);
      await page.screenshot({ path: file });
      const at = await scan(page);
      result.shots[id] = { file, at };
      console.log(`${id}: ok, "@" outside Connections ${at.filter((hit) => !hit.conn).length}`);
    } catch (error) {
      result.errors.push(`${id}: ${error.message.split("\n")[0]}`);
      await opened?.page.screenshot({ path: join(OUT, `ERR-${id}.png`) }).catch(() => {});
      console.log(`${id}: FAIL ${error.message.split("\n")[0]}`);
    } finally {
      await opened?.page.close().catch(() => {});
      await opened?.context.close().catch(() => {});
    }
  }
} finally {
  await app.close();
  writeFileSync(join(OUT, `result-${Date.now()}.json`), JSON.stringify(result, null, 1));
}
console.log(JSON.stringify({ shots: Object.keys(result.shots).length, errors: result.errors.slice(0, 8), minFreeGB: Math.min(...result.freeGB) }));
