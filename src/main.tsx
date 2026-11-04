import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { TraderPrototypeHarness } from "./components/TraderPrototypeHarness";
import { applySkin, readSkin } from "./lib/skins";
import { applyGeometry, readGeometry } from "./lib/geometry";
import { applyLocale, readOsLocaleTag, readPreference, resolveLocale } from "./lib/i18n";
import { startColdOpenTiming } from "./lib/cold-open-timing";
import { installRendererErrorReports } from "./lib/error-reports";
import { startPhoneSeen } from "./lib/phone-seen";
import "./styles.css";

const searchParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
const isProtoHarness = Boolean(searchParams?.has("proto"));
const protoSkin = searchParams?.get("skin");
const protoLocale = searchParams?.get("locale");

// Before the first paint, not inside a component: stamping the skin during
// render would show one frame of the default palette first.
applySkin((protoSkin as ReturnType<typeof readSkin>) || readSkin());
applyGeometry(readGeometry());
applyLocale(protoLocale === "ko" ? "ko" : protoLocale === "en" ? "en" : resolveLocale(readPreference(), readOsLocaleTag()));
if (isProtoHarness && typeof document !== "undefined") {
  document.documentElement.style.height = "auto";
  document.documentElement.style.overflow = "visible";
  document.body.style.height = "auto";
  document.body.style.overflow = "visible";
  const rootEl = document.getElementById("root");
  if (rootEl) {
    rootEl.style.height = "auto";
    rootEl.style.overflow = "visible";
  }
}
// Windows titleBarOverlay covers the top of the renderer; stamp the platform
// so CSS can reserve a global 32px caption inset before React mounts.
if (window.ogb?.platform === "win32") document.documentElement.dataset.orbitCaption = "win32";
// Before render: it strips the click time while App still reads the notification target from the url.
startColdOpenTiming();
installRendererErrorReports();
startPhoneSeen();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isProtoHarness ? <TraderPrototypeHarness /> : <App />}
  </StrictMode>,
);
