import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { capturePicture, parseFlags, pictureContext, recordPicture, shootPicture } from "../.claude/skills/verify-wink/picture-shots.mjs";

function picturePage(width = 1440) {
  const document = { fonts: { ready: Promise.resolve() }, images: [], body: { innerText: "출시 준비" }, querySelectorAll: () => [], querySelector: () => null };
  let font = "Arial";
  const evaluate = (fn) => runInNewContext(`(${fn})()`, { document, innerWidth: width, getComputedStyle: () => ({ fontFamily: font }) });
  const page = {
    addStyleTag: async ({ content }) => { font = content.match(/font-family: "([^"]+)"/)[1]; },
    evaluate,
    waitForFunction: async (fn) => { expect(evaluate(fn)).toBe(true); },
    screenshot: vi.fn(),
    goto: async () => {},
    locator: () => ({ first: () => ({ waitFor: async () => {} }) }),
    waitForTimeout: vi.fn(),
  };
  return { page, document };
}

describe("verify-wink pictures", () => {
  it("accepts equals flags and existing spaced flags", () => {
    expect(parseFlags(["phone", "--phone=360,392", "--font=Verdana", "--name", "sample"]))
      .toEqual({ args: ["phone"], flags: { phone: "360,392", font: "Verdana", name: "sample" } });
  });

  it("uses the requested Android CSS width", () => {
    expect(pictureContext(360)).toMatchObject({ viewport: { width: 360, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    expect(pictureContext(392).userAgent).toContain("Android");
    expect(pictureContext().viewport.width).toBe(1440);
    expect(() => pictureContext(0)).toThrow("width");
  });

  it("records observed viewport, font and fixture data", () => {
    const dir = mkdtempSync(join(tmpdir(), "wink-picture-manifest-"));
    const data = { longestEmail: "alex.morgan.workspace@example.com", longNames: ["Release preparation workspace"], korean: "출시 준비" };
    recordPicture(dir, { file: "desktop.png", w: 1440, font: "Arial", data });
    recordPicture(dir, { file: "phone.png", w: 392, font: "Verdana", data });
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(manifest.shots).toEqual([{ file: "desktop.png", w: 1440, font: "Arial" }, { file: "phone.png", w: 392, font: "Verdana" }]);
    expect(manifest.data).toEqual(data);
    recordPicture(dir, { file: "phone.png", w: 360, font: "Verdana", data });
    expect(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).shots).toHaveLength(2);
  });

  it("does not invent missing fixture data", () => {
    const dir = mkdtempSync(join(tmpdir(), "wink-picture-manifest-"));
    recordPicture(dir, { file: "empty.png", w: 360, font: "Arial", data: { longestEmail: "", longNames: [], korean: "" } });
    expect(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).data)
      .toEqual({ longestEmail: "", longNames: [], korean: "" });
  });

  it("refuses remote URL capture before starting a browser", async () => {
    await expect(capturePicture({ url: "https://example.com", phone: "360,392" }, "proof", ".", () => {})).rejects.toThrow("127.0.0.1");
    await expect(capturePicture({ url: "http://127.0.0.1:1234", phone: "0" }, "proof", ".", () => {})).rejects.toThrow("width");
  });

  it.each([undefined, "360,392"])("applies the stress font to every capture with phone widths %s", async (phone) => {
    const dir = mkdtempSync(join(tmpdir(), "wink-picture-font-"));
    const browser = {
      newContext: async ({ viewport }) => ({ newPage: async () => picturePage(viewport.width).page, route: async () => {}, close: async () => {} }),
      close: async () => {},
    };
    await capturePicture({ url: "http://127.0.0.1:1234", phone, font: "Verdana" }, "proof", dir, () => ({ chromium: { launch: async () => browser } }));
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(manifest.shots.map(({ w, font }) => ({ w, font }))).toEqual((phone ? [1440, 360, 392] : [1440]).map((w) => ({ w, font: "Verdana" })));
  });

  it("waits for fonts and incomplete images before capturing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wink-picture-settle-"));
    const { page, document } = picturePage();
    const fonts = Promise.withResolvers();
    const images = Promise.withResolvers();
    const waiting = Promise.withResolvers();
    document.fonts.ready = fonts.promise;
    document.images = [{ complete: true }, { complete: false }];
    page.waitForFunction = async (fn) => {
      expect(await page.evaluate(fn)).toBe(false);
      waiting.resolve("waiting");
      await images.promise;
      expect(await page.evaluate(fn)).toBe(true);
    };
    const capture = shootPicture(page, join(dir, "proof.png"), dir).then(() => "captured");
    expect(page.screenshot).not.toHaveBeenCalled();
    fonts.resolve();
    expect(await Promise.race([waiting.promise, capture])).toBe("waiting");
    expect(page.screenshot).not.toHaveBeenCalled();
    document.images[1].complete = true;
    images.resolve();
    await capture;
    expect(page.screenshot).toHaveBeenCalledOnce();
  });

  it("captures without a fixed pause", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wink-picture-pause-"));
    const { page } = picturePage();
    page.waitForTimeout = () => { throw new Error("fixed pause"); };
    const context = { newPage: async () => page, route: async () => {}, close: async () => {} };
    const browser = { newContext: async () => context, close: async () => {} };
    await capturePicture({ url: "http://127.0.0.1:1234" }, "proof", dir, () => ({ chromium: { launch: async () => browser } }));
    expect(page.screenshot).toHaveBeenCalledOnce();
  });
});
