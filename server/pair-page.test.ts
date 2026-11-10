import { readFileSync } from "node:fs";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../public/pair.html", import.meta.url), "utf8");
const body = /const phoneName = (\(\) => \{[\s\S]*?\n {8}\});/.exec(source)?.[1];

const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

const COPY = { en: { android: "Android phone", phone: "Phone" }, ko: { android: "Android 휴대폰", phone: "휴대폰" } };

function nameFor(userAgent: string, lang: "en" | "ko" = "en", maxTouchPoints = 0): string {
  expect(body, "phoneName not found in pair.html").toBeTruthy();
  const phoneName = vm.runInNewContext(`(${body})`, { navigator: { userAgent, maxTouchPoints }, t: (key: "android" | "phone") => COPY[lang][key] });
  return phoneName();
}

describe("pair page", () => {
  it('pair page names a Windows desktop "Windows PC"', () => {
    expect(nameFor(WINDOWS)).toBe("Windows PC");
  });

  it("names Mac and Linux desktops by OS, the same words in ko", () => {
    for (const lang of ["en", "ko"] as const) {
      expect([nameFor(WINDOWS, lang), nameFor(MAC, lang), nameFor(LINUX, lang)]).toEqual(["Windows PC", "Mac", "Linux PC"]);
    }
  });

  it("keeps iPhone, iPad and Android names", () => {
    expect(nameFor(IPHONE)).toBe("iPhone");
    expect(nameFor(MAC, "en", 5)).toBe("iPad");
    expect(nameFor(ANDROID)).toBe("Android phone");
    expect(nameFor(ANDROID, "ko")).toBe("Android 휴대폰");
  });
});
