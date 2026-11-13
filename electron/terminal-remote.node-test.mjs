import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";

import { createRemoteHosts, REMOTE_PANE_CEILING, remoteArgs, remoteHost, remoteLaunchLine, remoteSlot, remoteSshArgs, sshFailure } from "./terminal-remote.mjs";

const GB = 1024 ** 3;
const HOSTS = {
  work: { ssh: "work", root: "D:/wink-remote", account: "Me@Example.com", enabled: true },
  dad: { ssh: "dad", root: "D:/wink-remote", account: "me@example.com", enabled: false },
};
const WORK = remoteHost("work", HOSTS);
const GRANT = `0123abcd.${"A".repeat(43)}`;
const bootstrap = (line) => Buffer.from(line.match(/FromBase64String\('([^']+)'\)/)[1], "base64").toString("utf8");

function probeSsh(probe) {
  const calls = [];
  const ssh = async (target, script, input = "") => {
    calls.push({ target, script, input });
    return script.includes("FreePhysicalMemory") ? JSON.stringify(probe) : "";
  };
  return { ssh, calls };
}

test("reads only enabled hosts with a safe ssh target, root and account", () => {
  assert.deepEqual(WORK, { name: "work", ssh: "work", root: "D:\\wink-remote", account: "me@example.com" });
  assert.deepEqual(remoteHost("lab", { lab: { root: "E:\\wr\\", account: "me@example.com", enabled: true } }), { name: "lab", ssh: "lab", root: "E:\\wr", account: "me@example.com" });
  for (const name of ["dad", "home", "__proto__", "constructor"]) assert.throws(() => remoteHost(name, HOSTS), new RegExp(`Unknown terminal host: ${name}`));
  for (const entry of [{ ssh: "-oProxyCommand=calc" }, { ssh: "work host" }, { root: "wink-remote" }, { root: "D:/wink-remote/../x" }, { root: "D:/it's" }, { root: "C:/" }, { account: undefined }, { account: "me" }]) {
    assert.throws(() => remoteHost("work", { work: { ...HOSTS.work, ...entry } }), /Invalid terminal host: work/);
  }
});

test("keeps the bot's claude args and drops its home worker settings", () => {
  assert.equal(remoteArgs("claude --dangerously-skip-permissions 'Read card.md'"), " --dangerously-skip-permissions 'Read card.md'");
  assert.equal(remoteArgs("claude --model opus --settings C:\\Users\\me\\.orbit\\bin\\claude-worker.json \"Read card.md\""), " --model opus \"Read card.md\"");
  assert.equal(remoteArgs("& \"claude.exe\" --settings 'C:/Users/me x/.orbit/bin/claude-worker.json' -p hi"), " -p hi");
  assert.equal(remoteArgs("claude --settings D:/mine.json"), " --settings D:/mine.json");
  assert.equal(remoteArgs("claude"), "");
  for (const command of ["codex 'Read card.md'", "$env:A='1'; claude", "claude 'a'\r\nclaude 'b'", "claudex", "", undefined]) {
    assert.throws(() => remoteArgs(command), /one-line claude command/);
  }
});

test("picks a free tunnel port per host and counts the panes still starting there", () => {
  const at = 1_000_000;
  const panes = [{ host: "work", port: 40000, at: at - 61_000 }, { host: "work", port: 40001, at: at - 1_000 }, { host: "dad", port: 40002, at }];
  assert.deepEqual(remoteSlot("work", panes, at, () => 0), { host: "work", port: 40002, at, starting: 1 });
  assert.deepEqual(remoteSlot("dad", panes, at, () => 0), { host: "dad", port: 40000, at, starting: 1 });
  assert.equal(remoteSlot("work", [], at, (count) => count - 1).port, 48999);
  assert.equal(REMOTE_PANE_CEILING, 64);
  const full = Array.from({ length: REMOTE_PANE_CEILING }, (_, index) => ({ host: "work", port: 40000 + index, at: 0 }));
  assert.throws(() => remoteSlot("work", full, at), /Too many terminals on work \(limit 64\)/);
  assert.equal(remoteSlot("work", full.slice(1), at, () => 0).port, 40000);
});

test("the launch line splices the pane's env at run time and never types a grant", () => {
  const line = remoteLaunchLine({ host: WORK, port: 40123, cwd: "D:\\wink-remote\\wt\\it's", args: " --dangerously-skip-permissions 'Read card.md'" });
  assert.doesNotMatch(line, /[\r\n]/);
  assert.ok(line.startsWith("$s = ('$env:ORBIT_PANE = ''{0}''; $env:ORBIT_BOT = ''{1}''; $env:ORBIT_TEACHER = ''{2}''; $env:ORBIT_MSG_AUTH = ''{3}''; ' -f $env:ORBIT_PANE, $env:ORBIT_BOT, $env:ORBIT_TEACHER, $env:ORBIT_MSG_AUTH) + "));
  assert.ok(line.endsWith("; ssh -t -o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o ExitOnForwardFailure=yes -R \"40123:$(([uri]$env:ORBIT_URL).Authority)\" work \"powershell -NoProfile -EncodedCommand $([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($s)))\""));
  assert.deepEqual(bootstrap(line).split("\n"), [
    "$ErrorActionPreference = 'Stop'",
    "Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue",
    "$env:ORBIT_URL = 'http://localhost:40123'",
    "$env:CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION = 'false'",
    "$env:PATH = 'D:\\wink-remote\\bin;' + $env:PATH",
    "$env:ORBIT_SCRATCH = 'D:\\wink-remote\\scratch\\' + $env:ORBIT_PANE",
    "New-Item -ItemType Directory -Force $env:ORBIT_SCRATCH | Out-Null",
    "$env:TEMP = $env:ORBIT_SCRATCH; $env:TMP = $env:ORBIT_SCRATCH",
    "Set-Location -LiteralPath 'D:\\wink-remote\\wt\\it''s'",
    "& claude --dangerously-skip-permissions 'Read card.md' --settings 'D:/wink-remote/bin/claude-worker.json' --strict-mcp-config",
  ]);
  assert.throws(() => remoteLaunchLine({ host: WORK, port: 40123, cwd: "D:\\wink-remote", args: ` '${"x".repeat(11_000)}'` }), /Remote launch is too long/);
});

for (const shell of ["pwsh", "powershell"]) {
  test(`${shell} runs the typed line and hands ssh the spliced bootstrap`, { skip: process.platform !== "win32" }, () => {
    const line = remoteLaunchLine({ host: WORK, port: 40123, cwd: "D:\\wink-remote", args: " 'Read card.md'" });
    const script = `function ssh { ConvertTo-Json -Compress @($args) }\n${line}`;
    const env = { ...process.env, ORBIT_URL: "http://127.0.0.1:8799", ORBIT_PANE: "pane-1", ORBIT_BOT: "bot-1", ORBIT_TEACHER: "bot-2", ORBIT_MSG_AUTH: GRANT };
    const out = execFileSync(shell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", env, windowsHide: true, stdio: "pipe" });
    const args = JSON.parse(out);
    assert.deepEqual(args.slice(0, 12), ["-t", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4", "-o", "ExitOnForwardFailure=yes", "-R", "40123:127.0.0.1:8799", "work"]);
    const encoded = args[12].match(/^powershell -NoProfile -EncodedCommand (\S+)$/)[1];
    assert.equal(Buffer.from(encoded, "base64").toString("utf16le"), `$env:ORBIT_PANE = 'pane-1'; $env:ORBIT_BOT = 'bot-1'; $env:ORBIT_TEACHER = 'bot-2'; $env:ORBIT_MSG_AUTH = '${GRANT}'; ${bootstrap(line)}`);
  });
}

test("ssh calls run an encoded script with no prompts", () => {
  const args = remoteSshArgs("work", "Get-Date\n'é'");
  assert.deepEqual(args.slice(0, 5), ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "work"]);
  const encoded = args[5].match(/^powershell -NoProfile -NonInteractive -EncodedCommand (\S+)$/)[1];
  assert.equal(Buffer.from(encoded, "base64").toString("utf16le"), "Get-Date\n'é'");
});

test("ssh failures read as the host's first error or ssh's last line", () => {
  const clixml = "#< CLIXML\r\n<Objs Version=\"1.1.0.1\"><Obj S=\"progress\" RefId=\"0\"></Obj><S S=\"Error\">Access to the path 'D:\\wink-remote\\bin' is denied._x000D__x000A_</S><S S=\"Error\">At line:1 char:1_x000D__x000A_</S></Objs>";
  assert.equal(sshFailure("work", { code: 1 }, clixml).message, "ssh work failed: Access to the path 'D:\\wink-remote\\bin' is denied.");
  assert.equal(sshFailure("work", { code: 255 }, "Warning: something\r\nssh: connect to host work port 22: Connection timed out\r\n").message, "ssh work failed: ssh: connect to host work port 22: Connection timed out");
  assert.equal(sshFailure("work", { code: 1 }, "#< CLIXML\r\n<Objs Version=\"1.1.0.1\"></Objs>").message, "ssh work failed: exit 1");
  assert.equal(sshFailure("work", { killed: true }, "").message, "ssh work failed: timed out");
});

test("open probes the host, pushes changed bin files and returns the launch line", async () => {
  const { ssh, calls } = probeSsh({ free: 4 * GB, hash: "", account: "ME@example.com" });
  const line = await createRemoteHosts({ hosts: async () => HOSTS, ssh }).open({ name: "work", command: "claude 'Read card.md'", slot: { port: 40123, starting: 0 } });
  assert.equal(line, remoteLaunchLine({ host: WORK, port: 40123, cwd: "D:\\wink-remote", args: " 'Read card.md'" }));
  assert.deepEqual(calls.map((call) => call.target), ["work", "work"]);
  for (const part of ["Remove-Item Env:ANTHROPIC_API_KEY", "claude auth status", "FreePhysicalMemory", "D:\\wink-remote\\bin\\orbit-bin.hash"]) assert.ok(calls[0].script.includes(part), part);
  assert.equal(calls[0].input, "");
  assert.ok(calls[1].script.includes("'D:\\wink-remote\\bin'"));
  const files = JSON.parse(calls[1].input);
  const text = (name) => Buffer.from(files.find((file) => file.name === name).data, "base64").toString("utf8");
  assert.match(text("claude-worker.json"), /D:\/wink-remote\/bin\/orbit-msg\.ps1/);
  assert.match(text("orbit-msg.ps1"), /ORBIT_MSG_AUTH/);
  assert.equal(files.at(-1).name, "orbit-bin.hash");

  const again = probeSsh({ free: 4 * GB, hash: text("orbit-bin.hash"), account: "me@example.com" });
  const moved = await createRemoteHosts({ hosts: async () => HOSTS, ssh: again.ssh }).open({ name: "work", command: "claude", cwd: "D:/wink-remote/wt/x", slot: { port: 40124, starting: 0 } });
  assert.equal(again.calls.length, 1);
  assert.match(bootstrap(moved), /Set-Location -LiteralPath 'D:\\wink-remote\\wt\\x'/);
});

test("open refuses another account, a host short of memory, or a bad folder", async () => {
  const wrong = probeSsh({ free: 8 * GB, hash: "", account: "dad@example.com" });
  await assert.rejects(createRemoteHosts({ hosts: async () => HOSTS, ssh: wrong.ssh }).open({ name: "work", command: "claude", slot: { port: 40123, starting: 0 } }), /claude on work is signed in to another account/);
  assert.equal(wrong.calls.length, 1);

  const low = probeSsh({ free: 2.6 * GB, hash: "", account: "me@example.com" });
  const remote = createRemoteHosts({ hosts: async () => HOSTS, ssh: low.ssh });
  await assert.rejects(remote.open({ name: "work", command: "claude", slot: { port: 40123, starting: 1 } }), /Not enough free memory on work \(2\.6 GB free, 2\.7 GB needed\)/);
  await remote.open({ name: "work", command: "claude", slot: { port: 40123, starting: 0 } });

  const none = probeSsh({ free: 8 * GB, hash: "", account: "me@example.com" });
  const strict = createRemoteHosts({ hosts: async () => HOSTS, ssh: none.ssh });
  await assert.rejects(strict.open({ name: "dad", command: "claude", slot: { port: 40123, starting: 0 } }), /Unknown terminal host: dad/);
  for (const cwd of ["wt\\x", "D:\\a\r\nb", "\\\\server\\share"]) {
    await assert.rejects(strict.open({ name: "work", command: "claude", cwd, slot: { port: 40123, starting: 0 } }), /Invalid terminal folder on work/);
  }
  await assert.rejects(strict.open({ name: "work", command: "codex", slot: { port: 40123, starting: 0 } }), /one-line claude command/);
  assert.equal(none.calls.length, 0);
});
