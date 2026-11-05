import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export function parseFlags(argv) {
  const flags = {};
  const args = [];
  const switches = new Set(["fill", "full", "help"]);
  for (let i = 0; i < argv.length; i++) {
    const match = /^--([^=]+)=(.*)$/s.exec(argv[i]);
    if (match) flags[match[1]] = match[2];
    else if (!argv[i].startsWith("--")) args.push(argv[i]);
    else if (switches.has(argv[i].slice(2)) || argv[i + 1] === undefined || argv[i + 1].startsWith("--")) flags[argv[i].slice(2)] = true;
    else flags[argv[i].slice(2)] = argv[++i];
  }
  return { flags, args };
}

export function pictureContext(width) {
  if (width !== undefined && (!Number.isInteger(width) || width < 240 || width > 600)) throw new Error("phone width must be 240-600 CSS pixels");
  return width === undefined ? { viewport: { width: 1440, height: 900 } } : {
    viewport: { width, height: 844 }, screen: { width, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  };
}

export function recordPicture(dir, shot) {
  const file = join(dir, "manifest.json");
  const manifest = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { shots: [], data: { longestEmail: "", longNames: [], korean: "" } };
  manifest.shots = manifest.shots.filter((each) => each.file !== shot.file);
  manifest.shots.push({ file: shot.file, w: shot.w, font: shot.font });
  if (shot.data.longestEmail.length > manifest.data.longestEmail.length) manifest.data.longestEmail = shot.data.longestEmail;
  manifest.data.longNames = [...new Set([...manifest.data.longNames, ...shot.data.longNames])];
  if (shot.data.korean) manifest.data.korean = shot.data.korean;
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function shootPicture(page, file, dir, options = {}) {
  if (options.font) {
    if (!/^[\w -]+$/.test(options.font)) throw new Error("invalid font name");
    await page.addStyleTag({ content: `* { font-family: "${options.font}" !important; }` });
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => [...document.images].every((image) => image.complete));
  const observed = await page.evaluate(() => {
    const text = document.body.innerText;
    const emails = text.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) ?? [];
    const names = [...document.querySelectorAll('[data-sidebar-row-kind="bot"], [data-account-name], [data-connection-identity]')].map((el) => el.innerText.trim()).filter((name) => name.length >= 20);
    return {
      w: innerWidth,
      font: getComputedStyle(document.querySelector("textarea, button") ?? document.body).fontFamily.split(",")[0].replace(/["']/g, ""),
      data: { longestEmail: emails.sort((a, b) => b.length - a.length)[0] ?? "", longNames: names, korean: text.match(/[가-힣][가-힣\s]*/)?.[0].trim() ?? "" },
    };
  });
  await (options.selector ? page.locator(options.selector).screenshot({ path: file, animations: "disabled" }) : page.screenshot({ path: file, animations: "disabled", fullPage: Boolean(options.full) }));
  recordPicture(dir, { file: relative(dir, file), ...observed });
  return observed;
}

export async function capturePicture(flags, name, dir, playwright) {
  const url = new URL(flags.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password) throw new Error("--url must be http://127.0.0.1:<port>");
  const widths = flags.phone === undefined ? [] : String(flags.phone).split(",").map(Number);
  for (const width of widths) pictureContext(width);
  mkdirSync(join(dir, "shots"), { recursive: true });
  const browser = await playwright().chromium.launch({ headless: true });
  const files = [];
  try {
    for (const width of [undefined, ...widths]) {
      const context = await browser.newContext({ ...pictureContext(width), serviceWorkers: "block" });
      try {
        await context.route("**/*", (route) => new URL(route.request().url()).origin === url.origin ? route.continue() : route.abort());
        const page = await context.newPage();
        await page.goto(url.href);
        await page.locator("textarea[data-orbit-composer]").first().waitFor();
        const file = join(dir, "shots", `${name}-${width === undefined ? "desktop" : `phone-${width}`}.png`);
        await shootPicture(page, file, dir, flags);
        files.push(file);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return files;
}
