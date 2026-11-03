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
