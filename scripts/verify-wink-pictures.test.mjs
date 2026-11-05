import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { capturePicture, parseFlags, pictureContext, recordPicture } from "../.claude/skills/verify-wink/picture-shots.mjs";

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
});
