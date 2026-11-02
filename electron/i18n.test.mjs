import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { detectLocale, readPreference, resolveLocale, translate, uiFontStack, writePreference, en, ko } from "./i18n.mjs";

describe("packaged locale", () => {
  it("maps Korean OS tags onto Korean packaged copy", () => {
    expect(detectLocale("ko-KR")).toBe("ko");
    expect(resolveLocale("system", "ko")).toBe("ko");
    expect(resolveLocale("en", "ko-KR")).toBe("en");
  });

  it.each([
    ["ko-KR", "ko"],
    ["en-US", "en"],
    ["ja-JP", "en"],
  ])("uses %s on first launch to select %s", (osTag, locale) => {
    const dir = mkdtempSync(join(tmpdir(), "orbit-locale-"));
    try {
      expect(resolveLocale(readPreference(dir), osTag)).toBe(locale);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["en", "ko-KR", "en"],
    ["ko", "en-US", "ko"],
    ["system", "ko-KR", "ko"],
    ["system", "en-US", "en"],
  ])("persists %s in userData on %s and selects %s", (preference, osTag, locale) => {
    const dir = mkdtempSync(join(tmpdir(), "orbit-locale-"));
    try {
      writePreference(dir, preference);
      expect(readPreference(dir)).toBe(preference);
      expect(resolveLocale(readPreference(dir), osTag)).toBe(locale);
      expect(JSON.parse(readFileSync(join(dir, "locale-preference.json"), "utf8"))).toEqual({
        preference,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("has matching English and Korean packaged phrases", () => {
    expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort());
    expect(translate("ko", "packaged.bootTitle")).not.toBe(translate("en", "packaged.bootTitle"));
    expect(en["packaged.chooseFolder"]).toBe("Choose project folder");
    expect(ko["packaged.chooseFolder"]).toBe("프로젝트 폴더 선택");
  });

  it("includes Malgun Gothic in the packaged fallback stack", () => {
    expect(uiFontStack()).toContain("Malgun Gothic");
  });

  it("has Korean file link menu labels", () => {
    expect(ko["native.showInFolder"]).toBe("폴더에서 보기");
    expect(ko["native.saveCopy"]).toBe("사본 저장…");
    expect(ko["native.copyPath"]).toBe("경로 복사");
  });

  it("has Korean image menu labels", () => {
    expect(en["native.copyImage"]).toBe("Copy Image");
    expect(en["native.saveImage"]).toBe("Save Image As…");
    expect(ko["native.copyImage"]).toBe("이미지 복사");
    expect(ko["native.saveImage"]).toBe("이미지를 다른 이름으로 저장");
  });
});

describe("desktop viewer copy", () => {
  it.each(["en", "ko"])("keeps replacement tokens literal in %s device names", (locale) => {
    const name = "Laptop $& $' $` $$";
    expect(translate(locale, "packaged.deviceLinkHelp", { name })).toBe(
      locale === "ko"
        ? `${name}에서 설정 > 기기를 열고 링크 복사를 누르세요. 여기에 한 번만 붙여넣으면 됩니다.`
        : `On ${name}, open Settings > Devices and click Copy Link. Paste it here once.`,
    );
  });

  it("names the PC and Devices page in both paste instructions", () => {
    expect(translate("en", "packaged.deviceLinkHelp", { name: "Laptop" })).toBe("On Laptop, open Settings > Devices and click Copy Link. Paste it here once.");
    expect(translate("ko", "packaged.deviceLinkHelp", { name: "Laptop" })).toBe("Laptop에서 설정 > 기기를 열고 링크 복사를 누르세요. 여기에 한 번만 붙여넣으면 됩니다.");
    expect(en["packaged.deviceUnreachableHelp"]).toBe("Check that it's on and Tailscale is connected.");
    expect(ko["packaged.deviceUnreachableHelp"]).toBe("켜져 있고 Tailscale이 연결되어 있는지 확인하세요.");
  });

  it("paints the error page from packaged keys and includes Malgun Gothic", () => {
    const main = readFileSync(join(import.meta.dirname, "main.mjs"), "utf8");
    expect(main).toContain('nativeText("packaged.desktopUnavailable")');
    expect(main).toContain('nativeText("packaged.liveDesktopFailed")');
    expect(main).toContain('nativeText("packaged.openInBrowser")');
    expect(main).toContain('nativeText("packaged.liveDesktop")');
    expect(main).toMatch(/desktopViewerErrorPage[\s\S]*uiFontStack\(\)/);
  });
});

