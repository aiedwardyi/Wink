// Launch environments for the packaged smokes. They run the app or server against a
// disposable home, so nothing of the caller's profile may reach the child.
import { join } from "node:path";

import { smokeLauncherEnv } from "../server/testing/profile-env.ts";

export function relayServerEnv(parent, { home, port, resources }) {
  return {
    ...smokeLauncherEnv(parent, home),
    OMB_PORT: String(port),
    OMB_STATIC_DIR: join(resources, "ui"),
    OMB_RESOURCES_PATH: resources,
    OMB_SKILLS_DIR: join(resources, "skills"),
    OMB_USER_DATA: home,
    OMB_PACKAGED: "1",
    ORBIT_REMOTE_AUTO: "0",
  };
}

export function linuxDesktopEnv(parent, { home, xdgConfig, xdgRuntime, wayland, sentinel, brokerPort, cua }) {
  return {
    ...smokeLauncherEnv(parent, home),
    XDG_CONFIG_HOME: xdgConfig,
    XDG_RUNTIME_DIR: xdgRuntime,
    XDG_SESSION_TYPE: wayland ? "wayland" : "x11",
    XDG_CURRENT_DESKTOP: "GNOME",
    CUA_DRIVER_PATH: sentinel,
    OMB_COMPOSIO_BROKER_URL: `http://127.0.0.1:${brokerPort}`,
    OMB_SMOKE_TEST: "1",
    OMB_SMOKE_CUA: cua ? "1" : "0",
  };
}
