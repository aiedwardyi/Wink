import { useEffect, useRef, useState } from "react";

import { holdReload } from "./reload-hold";

export function useFileDrop(onFiles: (files: File[], isActive: () => boolean) => void | Promise<void>, disabled = false) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  useEffect(() => {
    let active = true;
    const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const enter = (e: DragEvent) => {
      if (disabled || !carriesFiles(e)) return;
      depth.current += 1;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const over = (e: DragEvent) => {
      if (carriesFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      if (!disabled) void holdReload(Promise.resolve(onFiles(Array.from(e.dataTransfer?.files ?? []), () => active)));
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      active = false;
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [onFiles, disabled]);
  return dragging;
}
