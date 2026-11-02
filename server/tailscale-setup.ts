import { execFile } from "node:child_process";
import { z } from "zod";
import type { ExecText } from "./remote-access.ts";

const nodeSchema = z.object({
  DNSName: z.string().optional(), UserID: z.number().optional(),
  OS: z.string().optional(), Online: z.boolean().optional(),
  HostName: z.string().optional(), CapMap: z.record(z.string(), z.unknown()).nullish(),
});
export const tailscaleStatusSchema = z.object({
  BackendState: z.string(), AuthURL: z.string().optional(), HaveNodeKey: z.boolean().optional(),
  Self: nodeSchema.nullish(), Peer: z.record(z.string(), nodeSchema).nullish(),
  User: z.record(z.string(), z.object({ LoginName: z.string().optional() })).nullish(),
});
export type TailscaleStatus = z.infer<typeof tailscaleStatusSchema>;

export function tailscaleCommands(platform: NodeJS.Platform): string[] {
  return platform === "win32" ? ["tailscale", "C:\\Program Files\\Tailscale\\tailscale.exe"] : ["tailscale"];
}

export function tailnetDevices(status: TailscaleStatus) {
  const userId = status.Self?.UserID;
  const peers = userId == null ? [] : Object.values(status.Peer ?? {}).filter((peer) => peer.UserID === userId && peer.Online);
  const tailnet = status.Self?.DNSName?.replace(/\.$/, "").split(".").slice(1).join(".");
  return {
    backendState: status.BackendState,
    haveNodeKey: status.HaveNodeKey,
    account: userId === undefined ? undefined : status.User?.[String(userId)]?.LoginName,
    phoneJoined: peers.some((peer) => /^(ios|android)$/i.test(peer.OS ?? "")),
    https: status.Self?.CapMap ? Object.hasOwn(status.Self.CapMap, "https") : undefined,
    pcs: peers.filter((peer) => /^(windows|macos|linux)$/i.test(peer.OS ?? "")).flatMap((peer) => {
      const host = peer.DNSName?.replace(/\.$/, "").toLowerCase();
      if (!host || !tailnet || !/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(host) || !host.endsWith(`.${tailnet}`)) return [];
      return [{ name: peer.HostName || host.split(".")[0], host }];
    }),
  };
}

export async function winkPeers(pcs: { name: string; host: string }[], request: typeof fetch = fetch) {
  const found: typeof pcs = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, pcs.length) }, async () => {
    while (next < pcs.length) {
      const pc = pcs[next++];
      try {
        const response = await request(`https://${pc.host}/api/health`, { signal: AbortSignal.timeout(1500), redirect: "error" });
        const health = z.object({ app: z.literal("openmausbot") }).safeParse(await response.json());
        if (response.ok && health.success) found.push(pc);
      } catch {}
    }
  }));
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

function authUrl(output: string): string | undefined {
  const match = output.match(/"AuthURL"\s*:\s*("(?:[^"\\]|\\.)*")/);
  if (!match) return;
  try {
    const value: string = JSON.parse(match[1]);
    const url = new URL(value);
    if (url.origin === "https://login.tailscale.com" && !url.username && !url.password) return value;
  } catch {}
}

export const loginText: ExecText = (file, args) => new Promise((resolve, reject) => {
  let output = "";
  const child = execFile(file, args, { timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
    if (authUrl(stdout)) resolve(stdout);
    else reject(error ?? new Error("Tailscale did not return a sign-in URL"));
  });
  child.stdout?.on("data", (data: string) => {
    output += data;
    if (!authUrl(output)) return;
    resolve(output);
    child.kill();
  });
});

export async function signInTailscale(exec: ExecText, platform: NodeJS.Platform, run: ExecText = exec) {
  for (const command of tailscaleCommands(platform)) {
    let status: TailscaleStatus;
    try {
      status = tailscaleStatusSchema.parse(JSON.parse(await exec(command, ["status", "--json"])));
    } catch { continue; }
    // Recheck at the command boundary: a stale renderer must never reconfigure a signed-in PC.
    if (status.BackendState !== "NeedsLogin" || status.HaveNodeKey) return { url: null };
    const existing = authUrl(JSON.stringify({ AuthURL: status.AuthURL }));
    if (existing) return { url: existing };
    try {
      return { url: authUrl(await run(command, ["up", "--json"])) ?? null };
    } catch (error) {
      const output = error instanceof Error && "stdout" in error ? String(error.stdout) : "";
      const url = authUrl(output);
      if (url) return { url };
      throw new Error("Tailscale sign-in failed");
    }
  }
  return { url: null };
}
