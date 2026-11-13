import { useEffect, useRef, useState } from "react";

import { holdReload } from "./reload-hold";

export function useFileDrop(onFiles: (files: File[], isActive: () => boolean) => void | Promise<void>, disabled = false) {
  const [dragging, setDragging] = useState(false);
  const intake = useRef({ onFiles });
  useEffect(() => {
    intake.current = { onFiles };
  }, [onFiles]);
  useEffect(() => {
    let active = true;
    let depth = 0;
    let inside: DragEvent | null = null;
    setDragging(false);
    const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    // Chromium marks a drag of an in-page image as "Files"; a cancelled start or a source gone mid-drag never sends dragend here.
    const fromInside = () => !!inside && !inside.defaultPrevented && (inside.target as Node).isConnected;
    const start = (e: DragEvent) => { inside = e; };
    const end = () => { inside = null; };
    const enter = (e: DragEvent) => {
      if (disabled || !carriesFiles(e) || fromInside()) return;
      depth += 1;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const over = (e: DragEvent) => {
      if (carriesFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      if (fromInside()) return end();
      const current = intake.current;
      if (!disabled) void holdReload(Promise.resolve(current.onFiles(Array.from(e.dataTransfer?.files ?? []), () => active && intake.current === current)));
    };
    window.addEventListener("dragstart", start);
    window.addEventListener("dragend", end);
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      active = false;
      window.removeEventListener("dragstart", start);
      window.removeEventListener("dragend", end);
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [disabled]);
  return dragging;
}
