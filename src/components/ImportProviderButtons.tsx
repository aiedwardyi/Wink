import { ROW_BUTTON } from "./SettingsPrimitives";
import { IMPORT_PROVIDERS, importLink } from "@/lib/import-links";

function open(url: string) {
  if (window.ogb?.openExternal) void window.ogb.openExternal(url).catch(() => {});
  else window.open(url, "_blank", "noopener,noreferrer");
}

export function ImportProviderButtons({ prompt }: { prompt: string }) {
  return (
    <div className="-mt-1 mb-2 flex flex-wrap gap-2">
      {IMPORT_PROVIDERS.map((provider) => (
        <button key={provider.name} type="button" className={ROW_BUTTON} onClick={() => open(importLink(provider, prompt))}>
          {provider.name}
        </button>
      ))}
    </div>
  );
}
