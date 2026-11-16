import type { MapWorker } from "../../shared/map-pane";

export interface MapSelection {
  follow: boolean;
  worker: string | null;
  path: string | null;
  pinned: string | null;
}

export function mapFollow(selection: MapSelection, workers: readonly MapWorker[]): MapSelection {
  const pinned = workers.some(worker => worker.id === selection.pinned) ? selection.pinned : null;
  const current = workers.find(worker => worker.id === selection.worker);
  const latest = workers.reduce<MapWorker | undefined>((last, worker) => !last || worker.editedAt > last.editedAt ? worker : last, undefined);
  const worker = pinned ? workers.find(worker => worker.id === pinned) : selection.follow ? latest : current ?? latest;
  const kept = worker?.files.some(file => file.path === selection.path);
  const path = worker && (selection.follow || worker.id !== selection.worker || !kept ? worker.path ?? worker.files[0]?.path : selection.path);
  return { ...selection, pinned, worker: worker?.id ?? null, path: path ?? null };
}
