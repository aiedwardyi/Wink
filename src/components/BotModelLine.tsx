// One source for "which model does this bot run": the sidebar row and every room bot list read it.
import { useI18n } from "@/lib/i18n";
import { modelChipText, modelFamilyAccent } from "@/lib/model-chip";
import { shownModelSelection, useStore, type Bot } from "@/state/store";

export function compactSidebarModelLabel(label: string): string {
  return label.replace(/\s+Contributor$/i, " Cont.");
}

export function useBotModel(bot: Pick<Bot, "modelSelection" | "pendingModelSelection">) {
  const { t } = useI18n();
  const { state } = useStore();
  const shown = bot.modelSelection && shownModelSelection(bot);
  if (!shown) return null;
  const engine = state.instances.find((instance) => instance.instanceId === shown.instanceId);
  const label = engine ? modelChipText({ instance: engine, model: shown.model, effort: shown.effort }, t) : null;
  return { label, text: label && compactSidebarModelLabel(label), accent: modelFamilyAccent(engine?.driverKind) };
}

export function BotModelLine({ bot }: { bot: Pick<Bot, "modelSelection" | "pendingModelSelection"> }) {
  const model = useBotModel(bot);
  if (!model?.text) return null;
  return (
    <span data-bot-model-line className="flex min-w-0 items-center gap-1.5 text-[13px] text-ink-secondary">
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: model.accent }} />
      <span className="min-w-0 flex-1 truncate">{model.text}</span>
    </span>
  );
}
