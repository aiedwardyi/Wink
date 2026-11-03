import "./ProfileFields.test-dom.ts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";

import { applyLocale } from "@/lib/i18n";

import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";

afterEach(() => applyLocale("en"));

it("shows the Auto-mode warning in Korean", () => {
  applyLocale("ko");
  const html = renderToStaticMarkup(createElement(LocalComputerAutoWarning, { open: true, onCancel: () => {}, onConfirm: () => {} }));
  expect(html).toContain("이 컴퓨터에서 자동 모드를 허용할까요?");
  expect(html).toContain("지켜보고 있을 때만 계속하세요");
  expect(html).toContain(">취소<");
  expect(html).toContain(">확인<");
  expect(html).not.toMatch(/Allow Auto mode|Cancel|>OK</);
});
