import { useCallback, useLayoutEffect, type RefObject } from "react";
import { findRowSelector } from "./chat-find.js";
import { composerNeedsTap, focusComposer, isDialogActive } from "./focus-composer.js";

// The transcript's bottom edge at the Reply tap, before the reply strip shrinks it.
const tapEdges = new WeakMap<HTMLElement, number>();

// A phone opens the keyboard only for focus inside the tap, never from the Composer effect after render.
export function useReplyFocus<T>(selectReply: (message: T) => void, scrollRef?: RefObject<HTMLElement | null>) {
  return useCallback((message: T) => {
    const scroller = scrollRef?.current;
    if (scroller) tapEdges.set(scroller, scroller.getBoundingClientRect().bottom);
    selectReply(message);
    if (composerNeedsTap() && !isDialogActive(document)) focusComposer();
  }, [selectReply, scrollRef]);
}

// The reply strip and a phone keyboard shrink the transcript from below, which slides the replied-to row behind the composer.
export function useReplyTargetInView(scrollRef: RefObject<HTMLElement | null>, messageId: string | undefined) {
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const tapped = tapEdges.get(scroller);
    tapEdges.delete(scroller);
    if (!messageId) return;
    const edge = () => scroller.getBoundingClientRect().bottom;
    // Only a row that showed above `shown` is kept; scrollTop snaps to device pixels, so a row up to a pixel lower still showed.
    const reveal = (shown: number) => {
      const row = scroller.querySelector(findRowSelector(messageId))?.lastElementChild?.getBoundingClientRect().bottom;
      if (row !== undefined && row > edge() && row <= shown + 1) scroller.scrollTop += row - edge();
    };
    if (tapped !== undefined) reveal(tapped);
    let shown = edge();
    const observer = new ResizeObserver(() => {
      const was = shown;
      shown = edge();
      if (shown < was) reveal(was);
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scrollRef, messageId]);
}
