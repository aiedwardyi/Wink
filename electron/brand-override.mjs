import fs from "node:fs";
import path from "node:path";

const ICON_TYPES = { ".png": "image/png", ".ico": "image/x-icon" };
const AVATAR_TYPES = [".png", ".jpg", ".jpeg", ".webp"];
const MAX_IMAGE_BYTES = 1024 * 1024;

// realpath first, so a link can't lead the file out of the data folder.
function dataFile(root, file, types) {
  if (typeof file !== "string") return null;
  const full = fs.realpathSync(path.resolve(root, file));
  const relative = path.relative(root, full);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  if (!types.includes(path.extname(full).toLowerCase())) return null;
  const stat = fs.statSync(full);
  return stat.isFile() && stat.size <= MAX_IMAGE_BYTES ? full : null;
}

function nameOf(value) {
  const name = typeof value === "string" ? value.trim() : "";
  return name && name.length <= 40 ? name : null;
}

function leadBotOf(root, value) {
  try {
    const name = nameOf(value?.name);
    const avatarPath = name && dataFile(root, value.avatar, AVATAR_TYPES);
    return avatarPath ? { name, avatarPath } : undefined;
  } catch {
    return undefined;
  }
}

/** A per-PC name and icon from `<dataDir>/brand.json`; anything off means plain Wink. */
export function readBrandOverride(dataDir) {
  try {
    const brand = JSON.parse(fs.readFileSync(path.join(dataDir, "brand.json"), "utf8"));
    const name = nameOf(brand?.name);
    if (!name) return null;
    const root = fs.realpathSync(dataDir);
    const iconPath = dataFile(root, brand.icon, Object.keys(ICON_TYPES));
    if (!iconPath) return null;
    const leadBot = leadBotOf(root, brand.leadBot);
    return { name, iconPath, ...(leadBot && { leadBot }) };
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
