import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Text fields under 16 px from before this check, per file. Fix one and lower its count; never raise one.
const KNOWN = new Map(Object.entries({
  "AccountNameEditor.tsx": 1,
  "ChatBubble.tsx": 1,
  "ChatFindBar.tsx": 1,
  "CommandPalette.tsx": 1,
  "CreateBotSheet.tsx": 2,
  "DeviceSwitcher.tsx": 1,
  "GroupView.tsx": 2,
  "GroupWizard.tsx": 2,
  "PhoneSetupFlow.tsx": 1,
  "PluginsPanel.tsx": 2,
  "RoomOwnName.tsx": 1,
  "Sidebar.tsx": 3,
  "StartFreshRow.tsx": 1,
  "TeamLibraryPanel.tsx": 4,
  "TeamRoomMenu.tsx": 1,
  "VoiceSettings.tsx": 1,
  "WorkingFolderField.tsx": 1,
}));

const TEXT_FIELD = /<(?:input|textarea)\b(?:(?!\/>)[\s\S])*\/>/g;
const SMALL = /(?:^|[\s"])text-(?:\[1[0-5](?:\.\d+)?px\]|xs|sm)(?![\w-])/;
const PHONE_SIZE = /(?:^|[\s"])(?:max-md:)?text-(?:\[16px\]|base)(?![\w-])/;

it("gives every phone text field 16 px text so iOS does not zoom the page on focus", () => {
  const components = join(dirname(fileURLToPath(import.meta.url)), "../components");
  const counts: Record<string, number> = {};
  for (const name of readdirSync(components)) {
    if (!name.endsWith(".tsx")) continue;
    for (const [field] of readFileSync(join(components, name), "utf8").matchAll(TEXT_FIELD)) {
      if (/type="(?:checkbox|radio|range|file|color|hidden)"/.test(field)) continue;
      if (SMALL.test(field) && !PHONE_SIZE.test(field)) counts[name] = (counts[name] ?? 0) + 1;
    }
  }
  const grown = Object.entries(counts).filter(([name, count]) => count > (KNOWN.get(name) ?? 0)).map(([name]) => name);
  expect(grown, "add max-md:text-[16px] to the new text field").toEqual([]);
});
