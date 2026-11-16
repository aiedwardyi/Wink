// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const storeState = vi.hoisted(() => ({ error: null as string | null }));
vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return { ...actual, useStore: () => ({ state: storeState, dispatch: () => undefined }) };
});

import { AppErrorBanner } from "./AppErrorBanner";

const here = dirname(fileURLToPath(import.meta.url));

describe("app error banner", () => {
  it("shows the app's error and nothing without one", () => {
    expect(renderToStaticMarkup(createElement(AppErrorBanner))).toBe("");
    storeState.error = "Couldn't reach the server";
    expect(renderToStaticMarkup(createElement(AppErrorBanner))).toContain("Couldn&#x27;t reach the server");
    storeState.error = null;
  });

  it.each(["ChatView.tsx", "GroupView.tsx", "JoinedRoomView.tsx", "TeamRoomView.tsx"])("shows above the %s transcript", (file) => {
    expect(readFileSync(join(here, file), "utf8")).toContain("<AppErrorBanner />");
  });
});
