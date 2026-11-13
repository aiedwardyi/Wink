// Draft rows survive failed creates.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { api, useStore, type Bot } from "@/state/store";
import { useI18n } from "@/lib/i18n";
import { pickerInstances } from "@/lib/cross-model-picker";
import { createTeamRoom } from "@/lib/team-rooms";
import { BotPickerList } from "./BotPickerList";
import {
  WIZARD_BOT_NAME_LIMIT,
  groupCreatePayload,
  newBotPayload,
  resolveWizardModel,
  suggestEngine,
  wizardEngineOptions,
  wizardModelOptions,
  type EnginePick,
} from "@/lib/group-wizard";
import { trackFeature } from "@/lib/usage-stats";

export interface NewRow {
  key: number;
  name: string;
  /** Engine override; null follows the live suggestion. */
  instanceId: string | null;
  model: string | null;
  saving: boolean;
  error: string | null;
}

const PREFERS = [["codex"], ["museAgent"]];
let nextRowKey = 1;

export function GroupWizard({
  onClose,
  closing = false,
}: {
  onClose: () => void;
  closing?: boolean;
}) {
  const { t } = useI18n();
  const { state, dispatch, refreshInstances } = useStore();
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [rows, setRows] = useState<NewRow[]>([]);
  const [addedNew, setAddedNew] = useState(0);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!closing) nameRef.current?.focus();
  }, [closing]);

  useEffect(() => {
    void refreshInstances?.();
  }, [refreshInstances]);

  const bots = state.bots.filter((b) => !b.hidden);

  // With no existing bots, start with the first name field.
  useEffect(() => {
    if (bots.length === 0) {
      setRows((prev) => (prev.length === 0 ? [{ key: nextRowKey++, name: "", instanceId: null, model: null, saving: false, error: null }] : prev));
    }
  }, [bots.length]);
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const patchRow = (key: number, patch: Partial<NewRow>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const addBot = async (row: NewRow, pick: EnginePick) => {
    const name = row.name.trim();
    if (!name || row.saving) return;
    patchRow(row.key, { saving: true, error: null });
    try {
      const selection = {
        instanceId: pick.instance.instanceId,
        model: resolveWizardModel(pick.instance, row.model),
      };
      const result: { bot: Bot } = await api("/api/bots", {
        method: "POST",
        body: JSON.stringify(newBotPayload(name, selection)),
      });
      dispatch({ type: "botAdded", bot: result.bot, activate: false, focusComposer: false });
      setPicked((prev) => new Set(prev).add(result.bot.id));
      setAddedNew((n) => n + 1);
      setRows((prev) => prev.filter((r) => r.key !== row.key));
    } catch (cause) {
      patchRow(row.key, { saving: false, error: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const saving = rows.some((row) => row.saving);
  const createGroup = () => {
    const memberIds = [...picked];
    if (creating || saving) return;
    setCreating(true);
    setCreateError(null);
    const title = name.trim() || t("groupWizard.namePrefill");
    const failed = () => {
      setCreating(false);
      setCreateError(t("groupWizard.createFailed"));
    };
    // No bots: a people group, hosted from the start.
    if (!memberIds.length) {
      createTeamRoom(title).then(({ group }) => {
        trackFeature("room.create", { n: 0 });
        dispatch({ type: "groupPatched", group });
        dispatch({ type: "select", id: group.id });
        onClose();
      }, failed);
      return;
    }
    dispatch({
      type: "createGroup",
      ...groupCreatePayload(title, memberIds),
      onSuccess: () => onClose(),
      onError: failed,
    });
  };

  return createPortal(
    <div
      data-closing={closing || undefined}
      inert={closing}
      className="animate-fade-in fixed inset-0 z-40 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onClose();
      }}
    >
      <div
        role={closing ? undefined : "dialog"}
        aria-modal={!closing || undefined}
        aria-labelledby="group-wizard-title"
        tabIndex={-1}
        className="animate-pop-in flex max-h-full w-full max-w-[380px] flex-col rounded-[24px] border border-hairline/50 bg-panel p-4 shadow-2xl shadow-black/50 outline-none"
      >
        <div id="group-wizard-title" className="mb-3 text-[15px] font-semibold text-ink">{t("groupWizard.title")}</div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <input
            ref={nameRef}
            autoFocus
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") createGroup();
            }}
            placeholder={t("groupWizard.nameTitle")}
            aria-label={t("groupWizard.nameTitle")}
            className="mb-3 w-full rounded-lg bg-raised/70 px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
          />

          <BotPickerList bots={bots} picked={picked} onToggle={toggle} emptyHint="" ordered />

          {rows.map((row, rowIndex) => (
            <NewBotRow
              key={row.key}
              row={row}
              preferIndex={addedNew + rowIndex}
              instances={state.instances}
              onPatch={(patch) => patchRow(row.key, patch)}
              onAdd={(pick) => void addBot(row, pick)}
            />
          ))}

          <button
            onClick={() => setRows((prev) => [...prev, { key: nextRowKey++, name: "", instanceId: null, model: null, saving: false, error: null }])}
            className="mt-2 text-[13px] font-medium text-accent hover:brightness-110"
          >
            {rows.length === 0 && addedNew === 0 ? t("groupWizard.newBot") : t("groupWizard.addAnother")}
          </button>

          <p className="mt-3 text-[12.5px] text-ink-secondary">{t("room.hint.everyone")}</p>

          {createError && <div role="alert" className="mt-2 text-[12.5px] text-danger">{createError}</div>}
        </div>

        <div className="mt-3 flex shrink-0 justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised/50">
            {t("groupWizard.cancel")}
          </button>
          <button
            onClick={createGroup}
            disabled={creating || saving}
            className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-accent-ink hover:brightness-110 disabled:opacity-40"
          >
            {t("groupWizard.create")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function NewBotRow({
  row,
  preferIndex,
  instances,
  onPatch,
  onAdd,
}: {
  row: NewRow;
  preferIndex: number;
  instances: ReturnType<typeof useStore>["state"]["instances"];
  onPatch: (patch: Partial<NewRow>) => void;
  onAdd: (pick: EnginePick) => void;
}) {
  const { t } = useI18n();
  const { dispatch } = useStore();
  const nameRef = useRef<HTMLInputElement>(null);
  const [nameInvalid, setNameInvalid] = useState(false);
  const preferKinds = PREFERS[Math.min(preferIndex, PREFERS.length - 1)]!;
  const instance = pickerInstances(instances).find((x) => x.instanceId === row.instanceId);
  const pick: EnginePick | null = instance
    ? { instance, substituted: false }
    : suggestEngine(instances, preferKinds);
  const preferKind = preferKinds[0]!;
  const showSubstituted = !!pick?.substituted && instances.some((i) => i.driverKind === preferKind);
  const engineOptions = wizardEngineOptions(instances, pick?.instance ?? null);
  const model = pick ? resolveWizardModel(pick.instance, row.model) : null;
  const nameErrorId = `group-wizard-name-error-${row.key}`;
  const submit = () => {
    if (!row.name.trim()) {
      setNameInvalid(true);
      nameRef.current?.focus();
      return;
    }
    if (pick && !row.saving) onAdd(pick);
  };

  return (
    <div className="mt-2 rounded-lg bg-raised/50 p-2.5">
      <label htmlFor={`group-wizard-name-${row.key}`} className="mb-1 block text-[12.5px] text-ink-secondary">
        {t("createBot.title")}
      </label>
      <input
        ref={nameRef}
        id={`group-wizard-name-${row.key}`}
        autoFocus
        value={row.name}
        maxLength={WIZARD_BOT_NAME_LIMIT}
        onChange={(e) => {
          setNameInvalid(false);
          onPatch({ name: e.target.value });
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        placeholder={t("groupWizard.botNamePlaceholder")}
        required
        aria-invalid={nameInvalid || undefined}
        aria-describedby={nameInvalid ? nameErrorId : undefined}
        className="w-full rounded-lg bg-raised/70 px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
      />
      {nameInvalid && (
        <p id={nameErrorId} role="alert" className="mt-1 text-[12px] text-danger">{t("groupWizard.botNameRequired")}</p>
      )}

      {pick ? (
        <div className="mt-1.5">
          <select
            aria-label={t("model.switchEngine")}
            value={pick.instance.instanceId}
            onChange={(e) => onPatch({ instanceId: e.target.value, model: null })}
            className="w-full rounded-lg bg-raised/70 px-2 py-1.5 text-[13px] text-ink"
          >
            {engineOptions.map((i) => (
              <option key={i.instanceId} value={i.instanceId}>{i.displayName}</option>
            ))}
          </select>
          <div className="mt-1.5 flex items-center gap-2 text-[12.5px] text-ink-secondary">
            <select
              aria-label={t("groupWizard.modelChange")}
              value={model ?? ""}
              onChange={(e) => onPatch({ model: e.target.value, instanceId: pick.instance.instanceId })}
              className="min-w-0 flex-1 rounded-lg bg-raised/70 px-2 py-1.5 text-[13px] text-ink"
            >
              {wizardModelOptions(pick.instance).map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
            <button
              onClick={submit}
              disabled={row.saving}
              className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-ink hover:brightness-110 disabled:opacity-40"
            >
              {t("groupWizard.addBot")}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-1.5 text-[12.5px] text-ink-secondary">
          <p className="mb-1">{t("groupWizard.noEngine")}</p>
          <button
            onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "connections" })}
            className="font-medium text-accent hover:brightness-110"
          >
            {t("groupWizard.connectAi")}
          </button>
        </div>
      )}
      {pick && showSubstituted && (
        <p className="mt-1 text-[12px] text-ink-secondary">
          {t("groupWizard.usingInstead", {
            preferred: preferredLabel(preferKind),
            used: pick.instance.displayName,
          })}
        </p>
      )}
      {row.error && <div role="alert" className="mt-1.5 text-[12.5px] text-danger">{row.error}</div>}
    </div>
  );
}

/** Friendly engine name for the substitution notice; unknown kinds print raw. */
function preferredLabel(kind: string): string {
  if (kind === "codex") return "Codex";
  if (kind === "museAgent") return "Meta Muse";
  return kind;
}
