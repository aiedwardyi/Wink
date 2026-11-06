// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import type { InstanceInfo } from "@/state/store";
import { ErrorRow } from "./ChatView";

function instance(snapshot: InstanceInfo["snapshot"]): InstanceInfo {
  // SAFETY: the sign-in rows read only these fields.
  return {
    instanceId: "codex",
    driverKind: "codex",
    displayName: "Codex",
    models: { default: "gpt-5.5", options: [] },
    snapshot,
    install: { login: { args: ["login"] }, signInCommand: "codex login" },
  } as InstanceInfo;
}

const row = (setupInstance: InstanceInfo, onRetry?: () => void) =>
  renderToStaticMarkup(createElement(I18nProvider, null,
    createElement(ErrorRow, { botId: "bot", message: "Codex is not signed in", setupInstance, onRetry })));

it("shows a signed-out turn as a calm sign-in card, not a red error", () => {
  const html = row(instance({ state: "available", authenticated: false }));
  expect(html).toContain("data-sign-in-card");
  expect(html).toContain("Sign in to Codex");
  expect(html).toContain(">Sign In<");
  expect(html).not.toContain("danger");
  expect(html).not.toContain(">Codex is not signed in<");
});

it("flips to Retry once the engine is signed in", () => {
  const html = row(instance({ state: "available", authenticated: true }), () => {});
  expect(html).toContain("Codex is ready");
  expect(html).toContain("Retry");
  expect(html).not.toContain(">Sign In<");
  expect(html).not.toContain("danger");
});

it("keeps the install card in the error box while the CLI is missing", () => {
  const html = row(instance({ state: "unavailable" }));
  expect(html).not.toContain("data-sign-in-card");
  expect(html).toContain("border-hairline/50 bg-inset");
});

it("keeps a bound sign-out card until that account is ready, then offers Retry", () => {
  const bound = (partial: Partial<InstanceInfo>) => renderToStaticMarkup(createElement(I18nProvider, null,
    createElement(ErrorRow, { botId: "bot", message: "Claude is not signed in.", signIn: true, bound: true, onRetry: () => {},
      setupInstance: { ...instance({ state: "available", authenticated: true }), instanceId: "acct_3", displayName: "Studio", ...partial } })));
  const stopped = bound({ accountState: "stopped" });
  expect(stopped).toContain("Studio is signed out");
  expect(stopped).toContain(">Sign In Again<");
  expect(stopped).not.toContain("Retry");
  const ready = bound({ accountState: "ready" });
  expect(ready).toContain("Studio is ready");
  expect(ready).toContain("Retry");
  expect(ready).not.toContain("Sign In Again");
});

it("stacks the computer-only instruction under the text instead of squeezing it beside", () => {
  const original = window.matchMedia;
  window.matchMedia = (() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  const html = renderToStaticMarkup(createElement(I18nProvider, null,
    createElement(ErrorRow, { botId: "bot", message: "Claude is not signed in.", signIn: true, bound: true,
      setupInstance: { ...instance({ state: "available", authenticated: true }), instanceId: "acct_3", displayName: "Studio", accountState: "stopped" } })));
  window.matchMedia = original;
  const host = document.createElement("div");
  host.innerHTML = html;
  const card = host.querySelector("[data-sign-in-card]")!;
  expect(card.textContent).toContain("Sign in on a computer");
  expect(card.className).toContain("flex-wrap");
  expect(card.lastElementChild!.className).toContain("basis-full");
});

it("gives the sign-in code input room for its whole placeholder", () => {
  const html = renderToStaticMarkup(createElement(I18nProvider, null,
    createElement(ErrorRow, { botId: "bot", message: "Claude is not signed in.", signIn: true, bound: true,
      setupInstance: { ...instance({ state: "available", authenticated: true }), instanceId: "acct_3", displayName: "Studio", accountState: "stopped",
        loginState: "pending", loginCapture: { inputGeneration: 1 } } })));
  const host = document.createElement("div");
  host.innerHTML = html;
  expect(host.querySelector("input[type=password]")!.className).toContain(" w-60 ");
});

it("keeps the open sign-in row beside the text and wraps it under only when the title no longer fits", () => {
  const html = renderToStaticMarkup(createElement(I18nProvider, null,
    createElement(ErrorRow, { botId: "bot", message: "Claude is not signed in.", signIn: true, bound: true,
      setupInstance: { ...instance({ state: "available", authenticated: true }), instanceId: "acct_3", displayName: "Studio", accountState: "stopped",
        loginState: "pending", loginCapture: { inputGeneration: 1, url: "https://example.test/login" } } })));
  const host = document.createElement("div");
  host.innerHTML = html;
  const card = host.querySelector("[data-sign-in-card]")!;
  const row = card.querySelector("[data-sign-in-open]")!;
  const text = card.children[1] as HTMLElement;
  const slot = card.lastElementChild as HTMLElement;
  expect(row.querySelector("input[type=password]")).not.toBeNull();
  expect(slot.contains(row)).toBe(true);
  // wraps (right-aligned) only when the text's own width plus the row no longer fit
  expect(card.className).toContain("[data-sign-in-open]");
  expect(card.className).toContain("flex-wrap");
  expect(text.className).toContain("group-has-[[data-sign-in-open]]/card:basis-52");
  expect(slot.className).toContain("has-[[data-sign-in-open]]:ml-auto");
  expect(slot.className).toContain("has-[[data-sign-in-open]]:max-w-full");
  // never forced onto its own line: that would leave a gap beside the text on wide cards
  expect(slot.className).not.toContain("[data-sign-in-open]]:basis-full");
  expect(row.className).toContain("items-end");
});
