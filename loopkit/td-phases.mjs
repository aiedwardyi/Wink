// Logs each phase of the terminal-discovery bridge test to phases.log, with the session hook's own steps.
import fs from "node:fs";
const file = process.argv[2] || "electron/terminal-discovery.test.mjs";
let text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const lap = (name) => '  __lap(' + JSON.stringify(name) + ');\n';
const rep = (anchor, next) => { if (!text.includes(anchor)) throw new Error("anchor not found: " + anchor); text = text.replace(anchor, next); };
rep('import { expect, it } from "vitest";\n', 'import { expect, it } from "vitest";\nimport __fs from "node:fs";\nconst __id = Math.random().toString(36).slice(2, 6); let __t0 = 0; let __prev = 0;\nconst __lap = (n) => { const t = Date.now(); __fs.appendFileSync("phases.log", __id + " " + n + " +" + (t - __prev) + " @" + (t - __t0) + "\\n"); __prev = t; };\n');
rep('  const root = await fs.mkdtemp(path.join(os.homedir(), "bridge-discovery-"));\n', '  __t0 = __prev = Date.now();\n  const root = await fs.mkdtemp(path.join(os.homedir(), "bridge-discovery-"));\n');
rep('  const bin = await installOrbitMsg(path.join(root, ".orbit", "bin"), "win32", profile);\n', '  const bin = await installOrbitMsg(path.join(root, ".orbit", "bin"), "win32", profile);\n' + lap("installOrbitMsg") +
  '  { const p = path.join(bin, "orbit-session.ps1"); const st = "[Console]::Error.WriteLine(\'ps \' + $args0 + \' \' + [DateTimeOffset]::Now.ToUnixTimeMilliseconds())"; let s = __fs.readFileSync(p, "utf8");\n' +
  '    s = st.replace("$args0", "\'start\'") + "\\r\\n" + s;\n' +
  '    s = s.replace("  try {\\r\\n    Invoke-RestMethod -Uri $env:ORBIT_SESSION_URL", "  " + st.replace("$args0", "\'old-url\'") + "\\r\\n  try {\\r\\n    Invoke-RestMethod -Uri $env:ORBIT_SESSION_URL");\n' +
  '    s = s.replace("    Invoke-RestMethod -Uri \\"$($current.url)", "    " + st.replace("$args0", "\'new-url\'") + "\\r\\n    Invoke-RestMethod -Uri \\"$($current.url)");\n' +
  '    s = s.replace("} catch { exit 1 }", "} catch { [Console]::Error.WriteLine(\'ps err \' + $_); exit 1 }\\r\\n" + st.replace("$args0", "\'end\'"));\n' +
  '    __fs.writeFileSync(p, s); }\n');
rep('  const old = await first.start();\n', '  const old = await first.start();\n' + lap("first.start"));
rep('  await first.close();\n', '  await first.close();\n' + lap("first.close"));
rep('    const current = await second.start(profile);\n', '    const current = await second.start(profile);\n' + lap("second.start"));
rep('    await publishTerminalDiscovery(profile, current, "http://127.0.0.1:8799");\n', '    await publishTerminalDiscovery(profile, current, "http://127.0.0.1:8799");\n' + lap("publish"));
rep('    const result = await new Promise(resolve => {\n', lap("before-hook") + '    const __spawn = Date.now();\n    const result = await new Promise(resolve => {\n');
rep('    expect(result.code, result.stderr).toBe(0);\n', lap("hook") + '    for (const m of String(result.stderr).matchAll(/ps (\\S+) (\\d+)/g)) __fs.appendFileSync("phases.log", __id + "   ps " + m[1] + " @" + (Number(m[2]) - __spawn) + " after spawn\\n");\n    if (/ps err/.test(result.stderr)) __fs.appendFileSync("phases.log", __id + "   " + result.stderr.match(/ps err.*/)[0] + "\\n");\n    expect(result.code, result.stderr).toBe(0);\n');
rep('  } finally { await second.close(); await host.dispose(); await restartedHost.dispose(); }\n', '  } finally { await second.close(); await host.dispose(); await restartedHost.dispose(); __lap("dispose"); }\n');
fs.writeFileSync(file, text);
for (let k = 1; k <= 16; k++) { const c = file.replace(".test.mjs", ".copy" + k + ".test.mjs"); if (fs.existsSync(c)) fs.writeFileSync(c, text); }
console.log("injected", file);
