import { useEffect, useState } from "react";

type Brand = { name: string; icon: string };

let pending: Promise<Brand | null> | undefined;

/** This PC's brand override, if its data folder has one; otherwise the empty spacer it replaces. */
export function BrandMark() {
  const [brand, setBrand] = useState<Brand | null>(null);
  useEffect(() => {
    let live = true;
    pending ??= window.ogb?.getBrand?.().catch(() => null) ?? Promise.resolve(null);
    void pending.then((value) => {
      if (live) setBrand(value);
    });
    return () => {
      live = false;
    };
  }, []);
  if (!brand) return <div />;
  return (
    <div data-brand-override className="-ml-1 flex min-w-0 items-center gap-2">
      <img src={brand.icon} alt="" className="size-6 shrink-0" />
      <span className="truncate text-[15px] font-semibold text-ink">{brand.name}</span>
    </div>
  );
}
