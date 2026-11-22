import { ROW_BUTTON } from "./SettingsPrimitives";
import { IMPORT_PROVIDERS, importLink } from "@/lib/import-links";

function open(provider: (typeof IMPORT_PROVIDERS)[number], prompt: string) {
  if (window.ogb?.openExternal) void window.ogb.openExternal(importLink(provider, prompt, true)).catch((error) => console.warn(`Could not open ${provider.name}`, error));
  else window.open(importLink(provider, prompt), "_blank", "noopener,noreferrer");
}

export function ImportProviderButtons({ prompt }: { prompt: string }) {
  return (
    <div className="-mt-1 mb-2 flex flex-wrap gap-2">
      {IMPORT_PROVIDERS.map((provider) => (
        <button key={provider.name} type="button" className={ROW_BUTTON} onClick={() => open(provider, prompt)}>
          {provider.name}
        </button>
      ))}
    </div>
  );
}
