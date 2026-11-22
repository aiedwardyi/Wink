import { ProviderBrandMark } from "@/components/ProviderIcons";
import { needsCli, needsSignIn } from "@/components/EngineSetup";
import { pickerModels, pickerRows, selectPickerModel } from "@/lib/cross-model-picker";
import { useI18n } from "@/lib/i18n";
import { modelEffortLabel } from "@/lib/model-chip";
import { useStore, type Bot, type ModelSelection } from "@/state/store";
import { Chevron, useModel } from "./GlassChat";

export type GlassModel = { key: string; kind: string; name: string; group: string; selection: ModelSelection; current: boolean };

/** The phone picker's rows, one per model, without engines that still need setup. */
export function useGlassModels(bot: Bot | undefined): GlassModel[] {
  const { state } = useStore();
  const { shown } = useModel(bot);
  if (!bot || !shown) return [];
  return pickerModels(pickerRows(state.instances, shown))
    .filter((item) => !needsCli(item.instance) && !needsSignIn(item.instance) && item.cell.options.length > 0)
    .map((item) => ({
      key: item.instance.instanceId + "/" + item.cell.label,
      kind: item.instance.driverKind,
      name: item.instance.driverKind === "claudeAgent" ? "Claude " + item.cell.label : item.cell.label,
      group: item.label,
      selection: selectPickerModel(item.instance, item.cell.options[0]!.id, shown),
      current: item.instance.instanceId === shown.instanceId && item.cell.options.some((option) => option.id === shown.model),
    }));
}

export function GlassModels({ bot, models, at }: { bot: Bot; models: GlassModel[]; at: number }) {
  const { t } = useI18n();
  const notch = models.length > 1 ? Math.round((at / (models.length - 1)) * 4) : 2;
  return (
    <div className="glass-layer">
      <div className="glass-ptop">
        <div className="glass-ptitle">
          <Chevron dir="left" />
          <span>Model</span>
        </div>
        <div className="glass-pctx">{bot.name}</div>
      </div>
      <div className="glass-pbody">
        <div className="glass-wheel">
          {[-2, -1, 0, 1, 2].map((off) => {
            const model = models[at + off];
            const place = off === 0 ? "on" : Math.abs(off) === 1 ? "near" : "far";
            if (!model) return <div key={"gap" + off} className={"glass-row gap " + place} />;
            return (
              <div key={model.key} className={"glass-row " + place}>
                <div className={"glass-badge " + model.kind}>
                  <ProviderBrandMark driverKind={model.kind} size={off ? 22 : 25} />
                </div>
                <div className="glass-minfo">
                  <div className="glass-mname">{model.name}</div>
                  {(model.current || !off) && <div className="glass-msub">{model.current ? "Current chat" : model.group}</div>}
                </div>
                {!off && model.selection.effort && <span className="glass-effort">{modelEffortLabel(model.selection.effort, t)}</span>}
                {off !== 0 && model.current && (
                  <span className="glass-cur">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M5 12.5l4.5 4.5L19 7" />
                    </svg>
                  </span>
                )}
              </div>
            );
          })}
        </div>
        <div className="glass-rail" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} className={i === notch ? "glass-notch on" : "glass-notch"} />
          ))}
        </div>
      </div>
    </div>
  );
}
