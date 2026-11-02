import { build } from "vite";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const scratch = process.env.WINK_DEVICE_PROOF_ROOT ?? join(tmpdir(), "wink-SAFE-B");
mkdirSync(scratch, { recursive: true });
process.env.TEMP = scratch;
process.env.TMP = scratch;
const overrides = new Map(['src/components/PhoneLinkSettings.tsx','src/components/DeviceSwitcher.tsx','src/components/SettingsModal.tsx','src/lib/i18n-catalog.ts','src/lib/phone-setup.ts','src/lib/settings-search.ts'].map(path => [root.replaceAll('\\','/')+'/'+path, execFileSync('git',['show','655e28f2:'+path],{cwd:root,encoding:'utf8',windowsHide:true})]));
writeFileSync(scratch+'/base-device-window.cjs',execFileSync('git',['show','655e28f2:electron/device-window.cjs'],{cwd:root,windowsHide:true}));
writeFileSync(scratch+'/desktop-viewer.cjs',execFileSync('git',['show','655e28f2:electron/desktop-viewer.cjs'],{cwd:root,windowsHide:true}));
for (const variant of ['today','new']) {
  await build({ root, configFile:root+'/vite.config.ts', configLoader:'runner', cacheDir:scratch+'/vite-'+variant, logLevel:'warn', plugins:variant==='today'?[{name:'baseline-source',enforce:'pre',load(id){return overrides.get(id.replaceAll('\\','/'));}}]:[], build:{outDir:scratch+'/dist-'+variant,emptyOutDir:true} });
  console.log('built '+variant);
}

writeFileSync(scratch+"/build-meta.json",JSON.stringify({sha:execFileSync("git",["rev-parse","HEAD"],{cwd:root,encoding:"utf8",windowsHide:true}).trim(),base:"655e28f2",builtAt:new Date().toISOString()},null,2));
