import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { brandForRenderer, brandWindowOptions, holdBrandTitle, readBrandOverride } from "./brand-override.mjs";

const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "main.mjs"), "utf8");
const PNG = Buffer.from("89504e470d0a1a0a", "hex");
let root;
let dataDir;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "brand-override-"));
  dataDir = join(root, ".orbit");
  mkdirSync(dataDir);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function brandFile(value) {
  writeFileSync(join(dataDir, "brand.json"), typeof value === "string" ? value : JSON.stringify(value));
}

describe("brand override", () => {
  it("stays plain Wink with no brand file", () => {
    expect(readBrandOverride(dataDir)).toBeNull();
    expect(brandWindowOptions(null, "/app/app-icon.png")).toEqual({ icon: "/app/app-icon.png" });
    expect(brandForRenderer(null)).toBeNull();
  });

  it("reads the name and an icon beside it", () => {
    writeFileSync(join(dataDir, "brand-icon.png"), PNG);
    brandFile({ name: " 커맨더 ", icon: "brand-icon.png" });
    const brand = readBrandOverride(dataDir);
    expect(brand).toEqual({ name: "커맨더", iconPath: join(dataDir, "brand-icon.png") });
    expect(brandWindowOptions(brand, "/app/app-icon.png")).toEqual({ icon: brand.iconPath, title: "커맨더" });
    expect(brandForRenderer(brand)).toEqual({ name: "커맨더", icon: `data:image/png;base64,${PNG.toString("base64")}` });
  });

  it("takes an .ico icon", () => {
    writeFileSync(join(dataDir, "brand-icon.ico"), PNG);
    brandFile({ name: "Desk", icon: "brand-icon.ico" });
    expect(brandForRenderer(readBrandOverride(dataDir))?.icon).toMatch(/^data:image\/x-icon;base64,/);
  });

  it("gives the sidebar mark the 48 px frame of an .ico", () => {
    const sizes = [16, 24, 48, 256];
    const frames = sizes.map((size) => Buffer.concat([PNG, Buffer.from([size])]));
    const head = Buffer.alloc(6 + 16 * sizes.length);
    head.writeUInt16LE(1, 2);
    head.writeUInt16LE(sizes.length, 4);
    let offset = head.length;
    sizes.forEach((size, i) => {
      head[6 + 16 * i] = size === 256 ? 0 : size;
      head.writeUInt32LE(frames[i].length, 14 + 16 * i);
      head.writeUInt32LE(offset, 18 + 16 * i);
      offset += frames[i].length;
    });
    writeFileSync(join(dataDir, "brand-icon.ico"), Buffer.concat([head, ...frames]));
    brandFile({ name: "Desk", icon: "brand-icon.ico" });
    expect(brandForRenderer(readBrandOverride(dataDir))?.icon).toBe(`data:image/png;base64,${frames[2].toString("base64")}`);
  });

  it.each([
    ["bad JSON", "{nope"],
    ["no name", { icon: "brand-icon.png" }],
    ["blank name", { name: "  ", icon: "brand-icon.png" }],
    ["long name", { name: "x".repeat(41), icon: "brand-icon.png" }],
    ["no icon", { name: "Desk" }],
    ["missing icon file", { name: "Desk", icon: "gone.png" }],
    ["icon not an image", { name: "Desk", icon: "brand.json" }],
    ["icon is the folder", { name: "Desk", icon: "." }],
  ])("ignores %s", (_label, value) => {
    writeFileSync(join(dataDir, "brand-icon.png"), PNG);
    brandFile(value);
    expect(readBrandOverride(dataDir)).toBeNull();
  });

  it("ignores an icon outside the data folder", () => {
    writeFileSync(join(root, "outside.png"), PNG);
    brandFile({ name: "Desk", icon: "../outside.png" });
    expect(readBrandOverride(dataDir)).toBeNull();
    brandFile({ name: "Desk", icon: join(root, "outside.png") });
    expect(readBrandOverride(dataDir)).toBeNull();
  });

  it("ignores a link that leads out of the data folder", () => {
    mkdirSync(join(root, "outside"));
    writeFileSync(join(root, "outside", "brand-icon.png"), PNG);
    symlinkSync(join(root, "outside"), join(dataDir, "linked"), "junction");
    brandFile({ name: "Desk", icon: "linked/brand-icon.png" });
    expect(readBrandOverride(dataDir)).toBeNull();
  });

  it("reads a lead bot with an avatar beside it", () => {
    writeFileSync(join(dataDir, "brand-icon.png"), PNG);
    writeFileSync(join(dataDir, "brand-lead.png"), PNG);
    brandFile({ name: "Desk", icon: "brand-icon.png", leadBot: { name: " 커맨더 ", avatar: "brand-lead.png" } });
    expect(readBrandOverride(dataDir)?.leadBot).toEqual({ name: "커맨더", avatarPath: join(dataDir, "brand-lead.png") });
  });

  it.each([
    ["no avatar", { name: "Lead" }],
    ["avatar outside", { name: "Lead", avatar: "../outside.png" }],
    ["avatar not an image", { name: "Lead", avatar: "brand.json" }],
    ["no name", { avatar: "brand-icon.png" }],
  ])("keeps the brand but drops a lead bot with %s", (_label, leadBot) => {
    writeFileSync(join(dataDir, "brand-icon.png"), PNG);
    writeFileSync(join(root, "outside.png"), PNG);
    brandFile({ name: "Desk", icon: "brand-icon.png", leadBot });
    expect(readBrandOverride(dataDir)).toEqual({ name: "Desk", iconPath: join(dataDir, "brand-icon.png") });
  });

  it("ignores an oversized icon", () => {
    writeFileSync(join(dataDir, "brand-icon.png"), Buffer.alloc(1024 * 1024 + 1));
    brandFile({ name: "Desk", icon: "brand-icon.png" });
    expect(readBrandOverride(dataDir)).toBeNull();
  });

  it("holds the window title only when branded", () => {
    const events = [];
    const win = { on: (name, handler) => events.push([name, handler]) };
    holdBrandTitle(win, null);
    expect(events).toEqual([]);
    holdBrandTitle(win, { name: "Desk", iconPath: "x.png" });
    let prevented = false;
    events[0][1]({ preventDefault: () => { prevented = true; } });
    expect(events[0][0]).toBe("page-title-updated");
    expect(prevented).toBe(true);
  });

  it("is wired into the windows, toasts and renderer from the data folder", () => {
    expect(main).toContain('const BRAND = readBrandOverride(process.env.OMB_DATA_DIR || path.join(app.getPath("home"), ".orbit"));');
    expect(main).toContain("...brandWindowOptions(BRAND, APP_ICON),");
    expect(main).toContain("holdBrandTitle(win, BRAND);");
    expect(main).toContain("appIcon: WINDOW_ICON,");
    expect(main).toContain('ipcMain.handle("desktop:brand", () => brandForRenderer(BRAND));');
    expect(main).not.toContain("icon: APP_ICON,");
    expect(main).toContain("...(BRAND?.leadBot && { OMB_BRAND_LEAD_BOT: JSON.stringify(BRAND.leadBot) }),");
  });
});
