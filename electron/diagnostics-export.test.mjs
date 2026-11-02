import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

function exportRoute(result, platform = "win32") {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const start = main.indexOf('ipcMain.handle("desktop:export-diagnostics",');
  const end = main.indexOf("// Bots hand users files", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const fs = {
    constants: { O_WRONLY: 1, O_CREAT: 2, O_TRUNC: 4, O_NOFOLLOW: 8 },
    writeFileSync: vi.fn(),
    openSync: vi.fn(() => 42),
    fchmodSync: vi.fn(),
    closeSync: vi.fn(),
  };
  const showSaveDialog = vi.fn(async () => result);
  const handle = vi.fn();
  runInNewContext(main.slice(start, end), {
    ipcMain: { handle },
    BrowserWindow: { fromWebContents: () => undefined },
    gatherDiagnostics: async () => "redacted report",
    dialog: { showSaveDialog },
    nativeText: () => "Export diagnostics",
    diagnosticsFileName: () => "wink-diagnostics.txt",
    process: { platform },
    fs,
  });
  expect(handle.mock.calls[0][0]).toBe("desktop:export-diagnostics");
  return { run: () => handle.mock.calls[0][1]({ sender: {} }), fs, showSaveDialog };
}

it("keeps the preload diagnostics bridge connected to its IPC route", () => {
  const preload = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
  expect(preload).toContain('exportDiagnostics: () => ipcRenderer.invoke("desktop:export-diagnostics")');
});

it("exports the redacted report to the chosen file", async () => {
  const route = exportRoute({ canceled: false, filePath: "chosen.txt" });
  expect(await route.run()).toBe("chosen.txt");
  expect(route.fs.writeFileSync).toHaveBeenCalledWith("chosen.txt", "redacted report", { mode: 0o600 });
});

it("does not write a cancelled export", async () => {
  const route = exportRoute({ canceled: true });
  expect(await route.run()).toBeNull();
  expect(route.fs.writeFileSync).not.toHaveBeenCalled();
});

it("keeps private permissions and refuses symlinks on Unix", async () => {
  const route = exportRoute({ canceled: false, filePath: "chosen.txt" }, "linux");
  expect(await route.run()).toBe("chosen.txt");
  expect(route.fs.openSync).toHaveBeenCalledWith("chosen.txt", 15, 0o600);
  expect(route.fs.fchmodSync).toHaveBeenCalledWith(42, 0o600);
  expect(route.fs.writeFileSync).toHaveBeenCalledWith(42, "redacted report", "utf8");
  expect(route.fs.closeSync).toHaveBeenCalledWith(42);
});
