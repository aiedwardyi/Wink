// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const load = async () => { vi.resetModules(); return (await import("./api-request")).clientId(); };
const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };

beforeEach(() => { window.name = ""; sessionStorage.clear(); localStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); window.name = ""; });

it("gives each tab its own sign-in id and keeps it across that tab's reload", async () => {
  const first = await load();
  expect(await load()).toBe(first);
  // A second tab of the same browser profile shares only local storage.
  window.name = "";
  sessionStorage.clear();
  const second = await load();
  expect(second).toMatch(/^[0-9a-f]{32}$/);
  expect(second).not.toBe(first);
});

it("keeps a tab's sign-in id across a reload when storage is blocked", async () => {
  vi.stubGlobal("localStorage", blocked);
  vi.stubGlobal("sessionStorage", blocked);
  const first = await load();
  expect(first).toMatch(/^[0-9a-f]{32}$/);
  expect(await load()).toBe(first);
});
