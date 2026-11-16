import { trackSetting } from "./usage-stats";

export type Geometry = "soft" | "boxy";

const KEY = "omb-shape";

export function readGeometry(): Geometry {
  try {
    return localStorage.getItem(KEY) === "boxy" ? "boxy" : "soft";
  } catch {
    return "soft";
  }
}

export function applyGeometry(geometry: Geometry): void {
  trackSetting("shape", document.documentElement.dataset["shape"], geometry, "settings", KEY);
  document.documentElement.dataset["shape"] = geometry;
  try {
    localStorage.setItem(KEY, geometry);
  } catch {
    /* The choice still applies for this session. */
  }
}
