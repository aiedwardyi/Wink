import fs from "node:fs";
import path from "node:path";

const ICON_TYPES = { ".png": "image/png", ".ico": "image/x-icon" };
const MAX_ICON_BYTES = 1024 * 1024;

/** A per-PC name and icon from `<dataDir>/brand.json`; anything off means plain Wink. */
export function readBrandOverride(dataDir) {
  try {
    const { name, icon } = JSON.parse(fs.readFileSync(path.join(dataDir, "brand.json"), "utf8"));
    if (typeof name !== "string" || !name.trim() || name.length > 40 || typeof icon !== "string") return null;
    const root = fs.realpathSync(dataDir);
    // realpath first, so a link can't lead the icon out of the data folder.
    const iconPath = fs.realpathSync(path.resolve(root, icon));
    const relative = path.relative(root, iconPath);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    if (!ICON_TYPES[path.extname(iconPath).toLowerCase()]) return null;
    const stat = fs.statSync(iconPath);
    if (!stat.isFile() || stat.size > MAX_ICON_BYTES) return null;
    return { name: name.trim(), iconPath };
  } catch {
    return null;
  }
}

export function brandForRenderer(brand) {
  if (!brand) return null;
  try {
    const type = ICON_TYPES[path.extname(brand.iconPath).toLowerCase()];
    return { name: brand.name, icon: `data:${type};base64,${fs.readFileSync(brand.iconPath).toString("base64")}` };
  } catch {
    return null;
  }
}

export function brandWindowOptions(brand, appIcon) {
  return brand ? { icon: brand.iconPath, title: brand.name } : { icon: appIcon };
}

/** The page's own <title> would otherwise rename the window back to Wink. */
export function holdBrandTitle(win, brand) {
  if (brand) win.on("page-title-updated", (event) => event.preventDefault());
}
