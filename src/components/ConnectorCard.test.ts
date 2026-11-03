import "./ProfileFields.test-dom.ts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { applyLocale } from "@/lib/i18n";
import type { ConnectorCardData, Message } from "@/state/store-types";

import { ConnectorCard } from "./ConnectorCard";

const card = (connector: Partial<ConnectorCardData>): Message => ({
  id: "c1", role: "bot", kind: "connector", at: 1,
  connector: { slug: "gmail", label: "Gmail", description: "Read your mail", status: "required", resumeKey: "k1", ...connector },
});

const render = (message: Message) =>
  renderToStaticMarkup(createElement(ConnectorCard, { botId: "b1", threadId: "t1", message }));

afterEach(() => applyLocale("en"));

describe("ConnectorCard in Korean", () => {
  it("translates the request card", () => {
    applyLocale("ko");
    const html = render(card({}));
    expect(html).toContain("안전하게 연결");
    expect(html).toContain("봇이 요청했어요");
    expect(html).toContain('aria-label="나중에"');
    expect(html).toContain("보안 연결 페이지");
    expect(html).not.toMatch(/Connect securely|Requested by your bot|Not now|secure connection page/);
  });

  it("translates the waiting and failed states", () => {
    applyLocale("ko");
    expect(render(card({ status: "authorizing" }))).toContain("로그인을 기다리는 중…");
    expect(render(card({ status: "authorizing" }))).toContain("다시 열기");
    expect(render(card({ status: "failed" }))).toContain("다시 시도");
  });

  it("translates the connected card", () => {
    applyLocale("ko");
    const html = render(card({ status: "connected" }));
    expect(html).toContain("연결됨");
    expect(html).toContain("준비되면 멈춘 작업을 이어가세요");
    expect(html).toContain("작업 이어가기");
    expect(html).toContain("사용할 수 있어요");
    expect(render(card({ status: "connected", resumed: true }))).toContain("이어가는 중");
  });
});
