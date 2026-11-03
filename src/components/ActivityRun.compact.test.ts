import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { applyLocale } from "@/lib/i18n";
import type { Message } from "@/state/store";

import { ActivityStep } from "./ActivityRun";

const message: Message = {
  id: "bash", role: "bot", kind: "activity", at: 1,
  tool: { name: "Bash", summary: "short command", ok: true, durationMs: 3100,
    detail: { input: "git status --short", output: ["one", "two", "three"], more: 52 } },
};

afterEach(() => {
  delete document.documentElement.dataset.skin;
  applyLocale("en");
});

describe("compact terminal steps", () => {
  it.each(["terminal", "terminal-dracula", "terminal-ice", "paper-tape", "logfile", "multiplexer", "modal", "tui", "tui-black", "tui-amber", "tui-ice", "tui-slate", "tui-smoke"])("uses one accessible expandable header in %s", (skin) => {
    document.documentElement.dataset.skin = skin;
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(createElement(ActivityStep, { message }));
    const header = host.querySelector("details > summary")!;
    expect(header).not.toBeNull();
    expect(header.textContent).toBe("Bash(git status --short)");
    expect(header.getAttribute("aria-label")).toContain("done, 3.1 seconds");
    expect(host.querySelector(".sr-only")).toBeNull();
    expect(host.querySelectorAll(".term-step-out > div")).toHaveLength(4);
  });

  it("keeps the captured call, summary and all retained output on expand", async () => {
    document.documentElement.dataset.skin = "terminal";
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(ActivityStep, { message })));
    try {
      const details = host.querySelector("details")!;
      expect(details).not.toBeNull();
      details.open = true;
      expect(details.textContent).toContain("git status --short");
      expect(details.querySelector("[data-term-call]")?.textContent).toContain("short command");
      expect([...host.querySelectorAll(".term-step-out > div")].slice(0, 3).map((row) => row.textContent)).toEqual(["one", "two", "three"]);
      expect(host.textContent).toContain("… +52 lines");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each(["auto", "always"] as const)("hides %s approval rows", (label) => {
    document.documentElement.dataset.skin = "terminal";
    const notice = { message: { ...message, id: "notice" }, label, tool: "Bash", summary: "short command" };
    const html = renderToStaticMarkup(createElement(ActivityStep, { message, notices: [notice] }));
    expect(html).not.toContain("term-notice");
    expect(html).not.toContain("Auto-approved");
    expect(html).not.toContain("Always allowed");
  });

  it("keeps failed and waiting steps visible in Korean", () => {
    document.documentElement.dataset.skin = "terminal";
    applyLocale("ko");
    const failed = { ...message, tool: { ...message.tool!, ok: false } };
    const html = renderToStaticMarkup(createElement(ActivityStep, { message: failed }));
    expect(html).toContain('data-term-step="failed"');
    expect(html).toContain("실패");
    expect(html).toContain("보관된 호출 및 출력 펼치기");
  });
});
