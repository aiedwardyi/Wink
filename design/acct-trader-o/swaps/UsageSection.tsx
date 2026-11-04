// Concept swap for src/components/UsageSection.tsx.
// Desktop: the desk fills the Settings pane. Phone: Usage gets the whole screen.
import { createPortal } from "react-dom";
import { useStore } from "@/state/store";
import { isPhone } from "@/lib/phone-swipe";
import { Desk } from "../Desk";
import { useDeskText } from "../strings";
import "../desk.css";

export function UsageSection() {
  const phone = isPhone();
  if (!phone) return <Desk />;
  return <PhoneUsage />;
}

function PhoneUsage() {
  const { dispatch } = useStore();
  const x = useDeskText();
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={x.t("usage")} data-desk-page className="desk-fade fixed inset-0 z-50 flex flex-col bg-panel">
      <div className="flex h-[52px] shrink-0 items-center justify-between px-4">
        <span className="text-[17px] font-semibold text-ink">{x.t("usage")}</span>
        <button type="button" onClick={() => dispatch({ type: "toggleAppSettings", open: false })}
          className="-mr-2 min-h-11 rounded-md px-2 text-[15px] font-medium text-accent-text">{x.t("done")}</button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        <Desk phone />
      </div>
    </div>,
    document.body,
  );
}
