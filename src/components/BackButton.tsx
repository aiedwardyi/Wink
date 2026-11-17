import { ChevronLeft } from "lucide-react";

export function BackButton({ label, ariaLabel, onClick }: { label: string; ariaLabel: string; onClick: () => void }) {
  return (
    <button type="button" data-back-button="" onClick={onClick} aria-label={ariaLabel} className="flex min-h-11 items-center gap-0.5 rounded-md px-1.5 text-[15px] text-accent hover:bg-control">
      <ChevronLeft size={20} />{label}
    </button>
  );
}
