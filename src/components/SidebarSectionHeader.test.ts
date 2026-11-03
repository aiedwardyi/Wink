// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";

import { applyLocale } from "@/lib/i18n";

import { SidebarSectionHeader } from "./SidebarSectionHeader";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => applyLocale("en"));

it("titles the reorder handle in Korean", async () => {
  applyLocale("ko");
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(createElement(SidebarSectionHeader, { name: "Pinned", reorderable: true, dragging: false })));
  expect(host.querySelector("[data-sidebar-section-handle]")?.getAttribute("title")).toBe("Alt+위/아래로 순서 변경");
  await act(async () => root.unmount());
  host.remove();
});
