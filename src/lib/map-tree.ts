import type { MapFile, MapWorker } from "../../shared/map-pane";

export interface MapNode extends MapFile {
  name: string;
  children?: MapNode[];
}

export function mapTree(files: readonly MapFile[]): MapNode[] {
  const root: MapNode = { path: "", name: "", added: 0, removed: 0, children: [] };
  const paths = new Map<string, MapNode>();
  for (const file of files) {
    let parent = root;
    const parts = file.path.split("/");
    parts.forEach((name, index) => {
      const folder = index < parts.length - 1;
      const path = parts.slice(0, index + 1).join("/");
      let node = paths.get(path);
      if (!node) {
        node = { ...file, path, name: folder ? `${name}/` : name, added: 0, removed: 0 };
        if (folder) node.children = [];
        parent.children!.push(node);
        paths.set(path, node);
      }
      node.added += file.added;
      node.removed += file.removed;
      parent = node;
    });
  }
  const collapse = (nodes: MapNode[]): MapNode[] => nodes.map(node => {
    while (node.children?.length === 1 && node.children[0].children) {
      const child = node.children[0];
      node = { ...child, name: node.name + child.name };
    }
    if (node.children) node.children = collapse(node.children);
    return node;
  }).sort((a, b) => Number(Boolean(b.children)) - Number(Boolean(a.children)) || a.name.localeCompare(b.name, "en"));
  return collapse(root.children!);
}

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
  const path = worker && (selection.follow || worker.id !== selection.worker ? worker.path ?? worker.files[0]?.path : selection.path);
  return { ...selection, pinned, worker: worker?.id ?? null, path: path ?? null };
}
