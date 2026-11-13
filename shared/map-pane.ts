export interface MapFile {
  path: string;
  added: number;
  removed: number;
  binary?: boolean;
}

export interface MapWorker {
  id: string;
  nick: string;
  task: string;
  git: boolean;
  editedAt: number;
  path?: string;
  reason?: string;
  files: MapFile[];
}

export interface MapSnapshot {
  workers: MapWorker[];
  error?: boolean;
}

export interface MapDiffLine {
  kind: "add" | "remove" | "context" | "fold";
  text: string;
  line?: number;
  count?: number;
}

export interface MapDiff {
  lines: MapDiffLine[];
  binary?: boolean;
  capped?: boolean;
}

export interface MapRepo {
  name: string;
  paths: string[];
}
