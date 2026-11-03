import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { createSecureCredentialState } from "./secure-credential-state.mjs";
import { migrateWorkspaceCredentials } from "./workspace-credentials.mjs";

const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");

function sourceBetween(start, end) {
  const first = main.indexOf(start);
  const last = main.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return main.slice(first, last).replaceAll("export async function", "async function");
}

function migrationFixture(config, stored = {}) {
  const writes = [];
  let release;
  let entered;
  const blocked = new Promise((resolve) => { release = resolve; });
  const persisting = new Promise((resolve) => { entered = resolve; });
  const state = createSecureCredentialState(stored, async (document) => {
    writes.push(structuredClone(document));
    if (writes.length === 1) {
      entered();
      await blocked;
    }
  });
  let currentConfig = structuredClone(config);
  let pendingConfig;
  const context = {
    secureCredentialState: state,
    secureCredentials: state.read(),
    migrateWorkspaceCredentials,
    structuredClone,
    process: { env: { OMB_DATA_DIR: "/test-data" }, pid: 1 },
    path,
    fs: {
      readFileSync: () => JSON.stringify(currentConfig),
      writeFileSync: (_file, value) => { pendingConfig = JSON.parse(value); },
      renameSync: () => { currentConfig = pendingConfig; },
    },
    slog: (message) => assert.fail(message),
  };
  runInNewContext([
    sourceBetween("async function persistMigratedCredentials(", "async function saveSecureCredentials("),
    sourceBetween("export async function secureComposioConfig(", "function composioBrokerUrl("),
    sourceBetween("export async function updateSecureCredentialDocument(", "function publicManagedCompanionState("),
  ].join("\n"), context);
  return { context, state, writes, release, persisting, config: () => currentConfig };
}

for (const [migration, config, field, secret] of [
  ["secureComposioConfig", { composio: { apiKey: "ak_legacy" } }, "composioApiKey", "ak_legacy"],
  ["secureWorkspaceConfig", { xai: { key: "legacy-xai" } }, "xaiApiKey", "legacy-xai"],
]) {
  test(`${migration} preserves a credential edit queued before migration`, async () => {
    const f = migrationFixture(config, { existing: "kept" });
    const boot = f.context.updateSecureCredentialDocument((credentials) => ({ ...credentials, account: "signed-in" }));
    await f.persisting;
    const edit = f.context.updateSecureCredentialDocument((credentials) => ({ ...credentials, boxToken: "saved" }));
    const migrated = f.context[migration]();
    f.release();
    await Promise.all([boot, edit, migrated]);
    const expected = { existing: "kept", account: "signed-in", boxToken: "saved", [field]: secret };
    assert.deepEqual(f.state.read(), expected);
    assert.deepEqual(structuredClone(f.context.secureCredentials), expected);
    assert.deepEqual(f.writes.at(-1), expected);
  });
}

test("Composio migration preserves a replacement key already queued by the user", async () => {
  const f = migrationFixture({ composio: { apiKey: "ak_legacy" } });
  const boot = f.context.updateSecureCredentialDocument((credentials) => credentials);
  await f.persisting;
  const edit = f.context.updateSecureCredentialDocument((credentials) => ({ ...credentials, composioApiKey: "ak_saved" }));
  const migrated = f.context.secureComposioConfig();
  f.release();
  await Promise.all([boot, edit, migrated]);
  assert.equal(f.state.read().composioApiKey, "ak_saved");
  assert.equal(f.context.secureCredentials.composioApiKey, "ak_saved");
  assert.equal(f.config().composio.apiKey, "");
});

test("Composio migration publishes credentials only after persistence succeeds", async () => {
  const f = migrationFixture({ composio: { apiKey: "ak_legacy" } }, { existing: "kept" });
  const captured = f.context.secureCredentials;
  const migrated = f.context.secureComposioConfig();
  await f.persisting;
  const beforeCommit = structuredClone(captured);
  f.release();
  await migrated;
  assert.deepEqual(beforeCommit, { existing: "kept" });
  assert.deepEqual(captured, { existing: "kept" });
  assert.equal(f.state.read().composioApiKey, "ak_legacy");
});

test("sequential boot migrations preserve an edit queued during the first write", async () => {
  const f = migrationFixture({ composio: { apiKey: "ak_legacy" }, xai: { key: "legacy-xai" } });
  const migrations = (async () => {
    await f.context.secureComposioConfig();
    await f.context.secureWorkspaceConfig();
  })();
  await f.persisting;
  const edit = f.context.updateSecureCredentialDocument((credentials) => ({ ...credentials, boxToken: "saved" }));
  f.release();
  await Promise.all([migrations, edit]);
  assert.deepEqual(f.state.read(), { composioApiKey: "ak_legacy", xaiApiKey: "legacy-xai", boxToken: "saved" });
  assert.deepEqual(structuredClone(f.context.secureCredentials), f.state.read());
});
