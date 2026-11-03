import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { firstLaunchConnectInstances, isEmptyEngineLaunch } from "@/lib/engine-rail";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "Onboarding.tsx"), "utf8");

describe("onboarding empty-engine path", () => {
  it("treats a loaded zoo with nothing available as the first-launch connect case", () => {
    expect(
      isEmptyEngineLaunch([
        { snapshot: { state: "unavailable" } },
        { snapshot: { state: "unavailable" } },
      ]),
    ).toBe(true);
    expect(
      firstLaunchConnectInstances([
        { instanceId: "codex", driverKind: "codex", install: { docsUrl: "https://codex" } },
        { instanceId: "grok", driverKind: "grokAgent", install: { docsUrl: "https://grok" } },
        { instanceId: "claude", driverKind: "claudeAgent", install: { docsUrl: "https://claude" } },
      ]).map((row) => row.instanceId),
    ).toEqual(["claude", "codex", "grok"]);
  });

  it("wires that path into the first-launch dialog instead of the engine zoo", () => {
    expect(source).toContain("<EngineConnect");
    expect(source).toContain("isEmptyEngineLaunch");
    expect(source).toContain('t("noEngines.title")');
    expect(source).toContain('t("noEngines.body")');
    expect(source).not.toContain('t("noEngines.checkAgain")');
  });

  it("uses EngineConnect instead of the old ready and setup cards", () => {
    expect(source).not.toContain("ReadyTile");
    expect(source).not.toContain("SetupRow");
    expect(source).not.toContain("CORE_DRIVERS");
    expect(source).not.toContain("snapshot.version?.split");
    expect(source).not.toMatch(/displayName\}.*version \? ` · \$\{version\}/);
  });

  it("lets an empty-engine launch skip into the shell", () => {
    expect(source).toContain("open: finish");
  });

  it("keeps Shift+Tab from the focused last-step dialog inside the trap", () => {
    expect(source).toContain("document.activeElement === first || document.activeElement === dialog");
  });
});
