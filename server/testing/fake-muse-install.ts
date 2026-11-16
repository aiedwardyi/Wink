// The native Windows Muse install layout: muse.cmd runs .muse-launcher.ps1,
// which runs muse-bin-<version>.exe named by .muse-version. The fake launcher
// runs `run` with node; the exe is a placeholder a test maps or leaves broken.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const museReleaseInfo = (version: string, channel = "muse-stable") =>
  JSON.stringify({
    channel,
    version,
    manifest_url: `https://lookaside.example/muse/${version}/manifest.json`,
    urgency: "none",
    notification_text: "",
    state: "public",
    min_version: null,
  });

/** What a launcher update leaves: a new exe name, and the version and release info naming it. */
export function museUpdate(dir: string, version: string): string {
  const exe = join(dir, `muse-bin-${version}.exe`);
  writeFileSync(exe, "not a real image");
  writeFileSync(join(dir, ".muse-version"), `${version}\n`);
  writeFileSync(join(dir, ".muse-release-info.json"), museReleaseInfo(version));
  return exe;
}

export function fakeMuseInstall(dir: string, run: string, version = "1.4.18-R1.1"): { cli: string; exe: string } {
  writeFileSync(
    join(dir, "muse.cmd"),
    '@echo off\r\nsetlocal\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0.muse-launcher.ps1" %*\r\nexit /b %ERRORLEVEL%\r\n',
  );
  writeFileSync(join(dir, ".muse-launcher.ps1"), `& '${process.execPath}' '${run}' @args\r\nexit $LASTEXITCODE\r\n`);
  writeFileSync(join(dir, ".muse-channel"), "muse-stable\n");
  writeFileSync(join(dir, ".muse-update-checked-at"), `${Math.floor(Date.now() / 1000)}\n`);
  return { cli: join(dir, "muse.cmd"), exe: museUpdate(dir, version) };
}
