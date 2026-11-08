import { expect, it } from "vitest";
import { check, failedLoad } from "./page-errors.mjs";

const origin = "http://127.0.0.1:1234";

it("reports load errors and broken local images, and keeps blocked remote images as a detail", () => {
  const result = check({ origin, errors: [{ where: "app.js:7", measured: "Uncaught TypeError" }], images: [{ where: "img#logo", src: `${origin}/logo.png`, broken: true }, { where: "img#dot", src: "data:image/png;base64,AA", broken: true }, ...[1, 2].map(n => ({ where: `img#u${n}`, src: `https://images.unsplash.com/${n}.jpg`, broken: true }))] });
  expect(result.problems.map(x => x.where)).toEqual(["app.js:7", "img#logo", "img#dot"]);
  expect(result.notChecked).toEqual([]);
  expect(result.details).toEqual([expect.objectContaining({ measured: "2 images from images.unsplash.com not loaded in the check" })]);
});

it("counts a missing same-origin image once next to a remote image and a missing favicon", () => {
  const result = check({ origin, loads: [], images: [{ where: "img#hero", src: `${origin}/hero.png`, broken: true }, { where: "img#photo", src: "https://picsum.photos/200", broken: true }] });
  expect(result.problems).toHaveLength(1);
});

it("leaves uncaught errors unchecked when the page's code is blocked", () => {
  const errors = [{ where: "index.html:9", measured: "ReferenceError: tailwind is not defined" }];
  const result = check({ origin, errors, loads: [{ where: "/missing.css", measured: "HTTP 404; reload the page" }], scriptsBlocked: "code from cdn.tailwindcss.com is blocked in the check" });
  expect(result.problems.map(x => x.where)).toEqual(["/missing.css"]);
  expect(result.notChecked).toEqual(["scripts (code from cdn.tailwindcss.com is blocked in the check)"]);
});

it("counts only same-origin page loads that really failed", () => {
  const load = (path, more = {}) => failedLoad({ url: `${origin}${path}`, type: "Image", status: 404, ...more }, origin);
  expect(load("/hero.png")).toBe(true);
  expect(load("/app.js", { type: "Script", status: 0, errorText: "net::ERR_FILE_NOT_FOUND" })).toBe(true);
  expect(load("/favicon.ico")).toBe(false);
  expect(load("/site.webmanifest", { type: "Manifest" })).toBe(false);
  expect(load("/next", { type: "Prefetch" })).toBe(false);
  expect(load("/ping", { type: "Ping" })).toBe(false);
  expect(load("/api", { type: "Fetch", status: 0, errorText: "net::ERR_ABORTED" })).toBe(false);
  expect(load("/blocked.js", { type: "Script", status: 0, blocked: true })).toBe(false);
  expect(failedLoad({ url: "https://images.unsplash.com/1.jpg", type: "Image", status: 404 }, origin)).toBe(false);
});
