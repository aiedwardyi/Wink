import { afterEach, expect, it, vi } from "vitest";
import { api } from "../state/store";
import { applyLocale } from "./i18n";

afterEach(() => { vi.unstubAllGlobals(); applyLocale("en"); });

it.each(["Failed to fetch", "Load failed"])("maps a fetch TypeError: %s", async (message) => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError(message)));
  await expect(api("/api/bots")).rejects.toThrow("Can't reach Wink. Check your connection.");
});

it("maps a non-JSON gateway error in Korean", async () => {
  applyLocale("ko");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>Bad Gateway</html>", { status: 502 })));
  await expect(api("/api/bots")).rejects.toThrow("Wink에 연결할 수 없어요. 인터넷 연결을 확인해 주세요.");
});

it("translates safe catch-all codes rather than showing the server's English", async () => {
  applyLocale("ko");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "INTERNAL_ERROR", error: "Wink couldn't finish that. Try again." }), { status: 500 })));
  await expect(api("/api/bots")).rejects.toThrow("Wink가 작업을 마치지 못했어요. 다시 시도해 주세요.");
});

it("keeps route errors and cancellations intact", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "this workspace is limited to 100 bots" }), { status: 400 })));
  await expect(api("/api/bots")).rejects.toThrow("this workspace is limited to 100 bots");
  const cancelled = new DOMException("cancelled", "AbortError");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(cancelled));
  await expect(api("/api/bots")).rejects.toBe(cancelled);
});

it("reaches curated fallbacks while keeping the network line", async () => {
  const { fallbackError, ConnectionError } = await import("./error-text");
  expect(fallbackError(new Error("invalid profile internals"), "Couldn't save your profile.")).toBe("Couldn't save your profile.");
  expect(fallbackError(new ConnectionError(), "Couldn't save your profile.")).toBe("Can't reach Wink. Check your connection.");
});
