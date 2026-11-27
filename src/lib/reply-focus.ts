import { useCallback } from "react";
import { composerNeedsTap, focusComposer, isDialogActive } from "./focus-composer.js";

// A phone opens the keyboard only for focus inside the tap, never from the Composer effect after render.
export function useReplyFocus<T>(selectReply: (message: T) => void) {
  return useCallback((message: T) => {
    selectReply(message);
    if (composerNeedsTap() && !isDialogActive(document)) focusComposer();
  }, [selectReply]);
}
