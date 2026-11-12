// The room header's member pictures, left to right in answer order. Drag one
// (long-press first on touch) or Alt+Left/Right to change who answers first.
import { useState, type ReactNode } from "react";

import { useI18n } from "@/lib/i18n";
import type { RoomDetailsSection } from "@/lib/room-details";
import { useMemberReorder } from "@/lib/use-member-reorder";
import { useStore, type Bot, type Group } from "@/state/store";

export function GroupMemberRoster({
  group,
  members,
  mauses,
  onOpen,
  children,
}: {
  group: Group;
  members: Bot[];
  mauses: ReactNode[];
  onOpen: (section: RoomDetailsSection) => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const { dispatch } = useStore();
  const [moved, setMoved] = useState("");
  const reorder = useMemberReorder(members.map((b) => b.id), (next, id) => {
    // ids with no bot behind them never show, so they keep their place at the end
    dispatch({ type: "patchGroup", groupId: group.id, patch: { memberIds: [...next, ...group.memberIds.filter((m) => !next.includes(m))] } });
    setMoved(t("room.memberMoved", { name: members.find((b) => b.id === id)?.name ?? "", position: next.indexOf(id) + 1, count: next.length }));
  });

  return (
    <div
      data-no-swipe
      onClick={(event) => onOpen(event.target instanceof Element && event.target.closest("[data-group-people-faces]") ? "people" : "bots")}
      onPointerDown={reorder.onPointerDown}
      onClickCapture={reorder.onClickCapture}
      onContextMenu={reorder.onContextMenu}
      onDragStart={(event) => event.preventDefault()}
      className="flex min-w-0 cursor-pointer select-none items-center gap-1.5 rounded-full py-0.5 pl-1 pr-1.5 [-webkit-touch-callout:none] hover:bg-raised/60 max-md:gap-0"
    >
      <span aria-live="polite" className="sr-only">{moved}</span>
      <div ref={reorder.rowRef} className="md:contents max-md:flex max-md:min-w-0 max-md:touch-pan-x max-md:items-center max-md:-space-x-1.5 max-md:overflow-x-auto max-md:[scrollbar-width:none] pointer-coarse:-my-3 pointer-coarse:py-3">
        {members.map((b, i) => (
          <button
            key={b.id}
            type="button"
            data-member-id={b.id}
            onKeyDown={reorder.onKeyDown}
            aria-label={b.name}
            aria-keyshortcuts={members.length > 1 ? "Alt+ArrowLeft Alt+ArrowRight" : undefined}
            className="relative flex shrink-0 rounded-full pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:-inset-y-3"
          >
            {mauses[i]}
          </button>
        ))}
      </div>
      {children}
    </div>
  );
}
