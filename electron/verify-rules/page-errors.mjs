export const id = "PAGE_ERRORS";
export const label = "page errors";

export function observe({ all, visible, where }) {
  return { images: all("img[src],img[srcset]").filter(visible).map(img => ({ where: where(img), src: img.currentSrc || img.src, pending: !img.complete, broken: img.complete && img.naturalWidth === 0 })) };
}

const loadTypes = new Set(["Document", "Script", "Stylesheet", "Image", "Media", "Font", "Fetch", "XHR"]);

export function failedLoad({ url, type, status = 0, errorText = "", blocked = false }, origin) {
  const target = new URL(url);
  if (blocked || target.origin !== origin || !loadTypes.has(type) || /\/(favicon|apple-touch-icon)[^/]*$|\.webmanifest$/i.test(target.pathname)) return false;
  return status >= 400 || /ERR_FILE_NOT_FOUND|ERR_NAME_NOT_RESOLVED/.test(errorText);
}

export function check({ errors = [], loads = [], images = [], origin = "", scriptsBlocked = "" }) {
  const problems = [], notChecked = [], remote = new Map();
  if (scriptsBlocked) notChecked.push(`scripts (${scriptsBlocked})`);
  else for (const e of errors) problems.push({ rule: "page error", ...e });
  for (const e of loads) problems.push({ rule: "page error", ...e });
  for (const img of images) if (img.broken) {
    const url = new URL(img.src, origin || undefined);
    if (url.protocol === "data:" || url.origin === origin) problems.push({ rule: "broken image", where: img.where, measured: "Image did not load; reload the page" });
    else remote.set(url.host, (remote.get(url.host) ?? 0) + 1);
  }
  if (images.some(img => img.pending)) notChecked.push("images not loaded");
  const details = [...remote].map(([host, n]) => ({ rule: "remote images", where: host, measured: `${n} ${n === 1 ? "image" : "images"} from ${host} not loaded in the check` }));
  return { problems, notChecked, details };
}
