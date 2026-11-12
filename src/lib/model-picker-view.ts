import { useSyncExternalStore } from "react";

export type ModelPickerView = "dial" | "list";

const KEY = "omb-model-picker-view";
const watchers = new Set<() => void>();

export function loadModelPickerView(): ModelPickerView {
  try {
    return localStorage.getItem(KEY) === "list" ? "list" : "dial";
  } catch {
    return "dial";
  }
}

export function saveModelPickerView(view: ModelPickerView): void {
  try {
    localStorage.setItem(KEY, view);
  } catch {
    /* The choice still applies for this session. */
  }
  for (const notify of watchers) notify();
}

function subscribe(notify: () => void) {
  watchers.add(notify);
  return () => { watchers.delete(notify); };
}

export function useModelPickerView(): ModelPickerView {
  return useSyncExternalStore(subscribe, loadModelPickerView, loadModelPickerView);
}
