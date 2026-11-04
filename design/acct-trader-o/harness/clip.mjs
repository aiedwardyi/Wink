// motion.mp4: numbers ticking live, the pace line moving, one manual switch, one automatic switch.
//   node --require ./guard.cjs --max-old-space-size=2048 clip.mjs [out.mp4]
// Frames come from the page's own compositor (CDP screencast), then ffmpeg makes a silent h264.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCRATCH, gateHeld, openPage, openSettings, ram, run, slash, startApp } from "./serve.mjs";

const OUT = process.argv[2] ?? join(SCRATCH, "motion.mp4");
const FFMPEG = process.env.FFMPEG ?? "C:/Users/mredw/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1-full_build/bin/ffmpeg.exe";
const FRAMES = join(SCRATCH, "clip-frames");
if (gateHeld()) {
  console.log(`timing gate holds HEAVY.lock (${gateHeld()}): holding`);
  process.exit(3);
}
ram("start");
rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

// A visible pointer and one caption, for the clip only (not product UI).
const overlay = () => {
  addEventListener("DOMContentLoaded", () => {
    const dot = document.createElement("div");
    dot.style.cssText = "position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;border:2px solid rgba(255,255,255,.92);background:rgba(255,255,255,.2);box-shadow:0 0 0 1px rgba(0,0,0,.5);pointer-events:none;z-index:2147483647;transform:translate(-100px,-100px);transition:background .12s";
    document.body.append(dot);
    addEventListener("mousemove", (event) => { dot.style.transform = `translate(${event.clientX}px,${event.clientY}px)`; }, true);
    addEventListener("mousedown", () => { dot.style.background = "rgba(110,160,255,.85)"; }, true);
    addEventListener("mouseup", () => setTimeout(() => { dot.style.background = "rgba(255,255,255,.2)"; }, 140), true);
    const cap = document.createElement("div");
    cap.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);padding:6px 14px;border-radius:999px;background:rgba(0,0,0,.72);color:#fff;font:500 14px/1.25 system-ui,sans-serif;z-index:2147483646;pointer-events:none;opacity:0;transition:opacity .25s;white-space:nowrap";
    document.body.append(cap);
    window.__clip = {
      caption: (text, top) => {
        if (text) {
          cap.textContent = text;
          cap.style.top = `${top}px`;
        }
        cap.style.opacity = text ? "1" : "0";
      },
    };
  });
};

const app = await startApp("new");
let opened;
let closed = false;
const errors = [];
try {
  opened = await openPage(app, { width: 1280, phone: false, locale: "en", skin: "github-dimmed", reduced: false, extra: overlay });
  const { page, context } = opened;
  page.on("pageerror", (error) => errors.push(error.message.split("\n")[0]));
  await openSettings(page, { phone: false, locale: "en" }, "usage");
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(1120, 640);
  await page.waitForTimeout(1500);
  const card = await page.locator('[role="dialog"][aria-modal="true"]').first().boundingBox();
  const crop = { x: Math.max(0, card.x - 28), y: Math.max(0, card.y - 52), w: card.width + 56, h: card.height + 76 };

  const cdp = await context.newCDPSession(page);
  const frames = [];
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    const file = join(FRAMES, `f${String(frames.length).padStart(5, "0")}.jpg`);
    writeFileSync(file, Buffer.from(data, "base64"));
    frames.push({ file, t: metadata.timestamp });
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: 2560, maxHeight: 1600, everyNthFrame: 1 });
  const t0 = Date.now();
  const at = async (ms) => {
    const wait = ms - (Date.now() - t0);
    if (wait > 0) await page.waitForTimeout(wait);
  };
  const glide = async (locator, ms) => {
    const box = await locator.boundingBox();
    await page.mouse.move(box.x + box.width * 0.45, box.y + box.height / 2, { steps: Math.max(8, Math.round(ms / 16)) });
  };
  const press = async () => {
    await page.mouse.down();
    await page.waitForTimeout(70);
    await page.mouse.up();
  };

  // 1. Live: two engine reports land; the % eases, the tip steps down, the dashed pace line drops.
  await at(700);
  await page.evaluate(() => window.__desk.report("claude", "5h", 68));
  await at(2000);
  await page.evaluate(() => window.__desk.report("claude", "5h", 70.5));
  // 2. Manual switch: one tap on Claude 3.
  await at(3100);
  await glide(page.getByRole("radio", { name: /^Claude 3:/ }).first(), 520);
  await press();
  // 3. Codex: the pace line says it runs out tomorrow morning, then Codex 2.
  await at(5000);
  await glide(page.getByRole("tab", { name: /^Codex/ }).first(), 480);
  await press();
  await at(5700);
  // The pointer leaves the frame once it has done its two taps.
  await page.mouse.move(Math.min(1270, crop.x + crop.w + 60), crop.y + crop.h / 2, { steps: 20 });
  // 4. Automatic switch: time runs forward to Thu 8:31 AM; Codex 1 hits 0 and Wink moves new work to 2.
  await at(6400);
  await page.evaluate((top) => window.__clip.caption("Next morning, sped up", top), Math.round(card.y - 40));
  await page.evaluate(() => window.__desk.nextMorning(2600));
  await at(9500);
  await page.evaluate(() => window.__clip.caption(""));
  await at(11000);
  await cdp.send("Page.stopScreencast");
  const end = Date.now() / 1000;
  if (frames.length < 60) throw new Error(`only ${frames.length} frames`);

  const lines = frames.map((frame, i) => {
    const next = frames[i + 1]?.t ?? Math.max(frame.t + 0.05, end);
    return `file '${slash(frame.file)}'\nduration ${Math.max(0.001, next - frame.t).toFixed(4)}`;
  });
  writeFileSync(join(FRAMES, "list.txt"), `${lines.join("\n")}\nfile '${slash(frames.at(-1).file)}'\n`);
  const W = 1280;
  const H = 800;
  const vf = `crop=iw*${(crop.w / W).toFixed(5)}:ih*${(crop.h / H).toFixed(5)}:iw*${(crop.x / W).toFixed(5)}:ih*${(crop.y / H).toFixed(5)},scale=1280:-2:flags=lanczos,fps=30,format=yuv420p`;
  // The browser closes first, then ffmpeg runs alone (hidden, BelowNormal via guard.cjs).
  await opened.page.close().catch(() => {});
  await opened.context.close().catch(() => {});
  await app.close();
  closed = true;
  await run(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-threads", "4", "-f", "concat", "-safe", "0", "-i", join(FRAMES, "list.txt"),
    "-vf", vf, "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-an", "-movflags", "+faststart", OUT]);
  console.log(JSON.stringify({ out: OUT, frames: frames.length, seconds: Number((frames.at(-1).t - frames[0].t).toFixed(2)), crop, errors }));
} finally {
  if (!closed) {
    await opened?.page.close().catch(() => {});
    await opened?.context.close().catch(() => {});
    await app.close();
  }
}
