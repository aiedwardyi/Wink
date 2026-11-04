import { Brain } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useStore, type Bot, type Message } from "@/state/store";
import { useMemoryClean, type MemoryCleanRun } from "@/lib/memory-clean";
import { MemoryCleanUndo } from "./MemoryCleanRow";
import { MemorySaveChip } from "./MemorySaveChip";

export function MemoryTidyLine({ tidy, run, onUndo }: { tidy: { runId: string; undoneAt?: number }; run: MemoryCleanRun | null; onUndo: () => void }) {
  const { t } = useI18n();
  const { dispatch } = useStore();
  const undone = tidy.undoneAt !== undefined || (run?.runId === tidy.runId && run.undoneAt !== null);
  return (
    <div className="flex justify-start">
      <div className="flex min-w-0 max-w-full items-start gap-2 rounded-lg border border-transparent px-3 py-1.5 text-[13px] text-ink-secondary">
        <span className="inline-flex h-[1.5em] shrink-0 items-center"><Brain size={13} /></span>
        <span className="min-w-0 max-w-[480px] break-keep leading-[1.5]">
          {undone ? t("chat.memoryTidyUndone") : <><button type="button" className="inline text-left" onClick={() => dispatch({ type: "toggleSettings", open: true, memory: { cleanup: true } })}>{t("chat.memoryTidied")}</button>{run?.runId === tidy.runId && run.undoable && <> <MemoryCleanUndo onUndo={onUndo} /></>}</>}
        </span>
      </div>
    </div>
  );
}

function MemoryTidySave({ message, bot }: { message: Message; bot: Bot }) {
  const { run, undo } = useMemoryClean(bot.id, bot.messages);
  return <MemoryTidyLine tidy={message.tool!.tidy!} run={run} onUndo={undo} />;
}

export function MemoryCleanSave({ message, bot }: { message: Message; bot: Bot }) {
  return message.tool?.tidy ? <MemoryTidySave message={message} bot={bot} /> : <MemorySaveChip summary={message.tool?.spoken ?? ""} lines={message.tool?.lines} at={message.at} />;
}
