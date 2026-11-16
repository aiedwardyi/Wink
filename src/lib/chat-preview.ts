import { createContext, createElement, startTransition, useContext, useEffect, useState, type ReactNode } from "react";

export const CHAT_PEEK_WINDOW_SIZE = 4;
export const ChatPreviewContext = createContext(false);
export const useChatPreview = () => useContext(ChatPreviewContext);

// A peeked page mounts one part per frame so no commit outlasts a frame: shell, controls, composer, then rows oldest first, appended so mounted rows keep their style.
const PEEK_PARTS = { controls: 1, composer: 2, rows: 3 };
const PEEK_SETTLED = PEEK_PARTS.rows + CHAT_PEEK_WINDOW_SIZE;
const ChatPeekPartContext = createContext(PEEK_SETTLED);
const ChatPeekSettledContext = createContext(true);

export const useChatPeekSettled = () => useContext(ChatPeekSettledContext);

/** Window rows a peeked transcript has mounted so far, from its oldest. */
export function useChatPeekRows(): number {
  const part = useContext(ChatPeekPartContext);
  return part >= PEEK_SETTLED ? Infinity : Math.max(0, part - PEEK_PARTS.rows + 1);
}

export function peekRows<T>(rows: T[], count: number): T[] {
  return count < rows.length ? rows.slice(0, count) : rows;
}

export function ChatPeekPart({ part, children }: { part: "controls" | "composer"; children: ReactNode }) {
  return useContext(ChatPeekPartContext) >= PEEK_PARTS[part] ? children : null;
}

export function ChatPeekParts({ id, preview, children }: { id: string; preview: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState({ id, part: preview ? 0 : PEEK_SETTLED });
  if (preview && mounted.id !== id) setMounted({ id, part: 0 });
  const part = !preview ? PEEK_SETTLED : mounted.id === id ? mounted.part : 0;
  useEffect(() => {
    if (part >= PEEK_SETTLED) return;
    const frame = requestAnimationFrame(() => startTransition(() => setMounted({ id, part: part + 1 })));
    return () => cancelAnimationFrame(frame);
  }, [id, part]);
  return createElement(ChatPeekPartContext.Provider, { value: part },
    createElement(ChatPeekSettledContext.Provider, { value: part >= PEEK_SETTLED }, children));
}
