import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

import type { MediaMessage } from "../src/lib/chat-media.ts";
import { messageDatabase } from "./message-db.ts";

export type MediaRow = MediaMessage & { id: string; at: number; roomEcho?: unknown };

type PageRow = { id: string } & ({ at: null } | {
  at: number;
  role: string;
  kind: string;
  text: string | null;
  image: string | null;
  summarized: SQLOutputValue;
  roomEcho: SQLOutputValue;
});

// A missing parent predates branching and follows insertion order; a null parent ends the path.
const SQL = `
  WITH RECURSIVE path(id, depth) AS (
    VALUES (?2, 0)
    UNION ALL
    SELECT CASE WHEN json_type(m.json, '$.parentId') IS NOT NULL THEN json_extract(m.json, '$.parentId')
      ELSE (SELECT prior.id FROM messages prior WHERE prior.thread_id = ?1 AND prior.rowid < m.rowid ORDER BY prior.rowid DESC LIMIT 1)
      END, path.depth + 1
    FROM path JOIN messages m ON m.thread_id = ?1 AND m.id = path.id
    LIMIT ?3 + 1
  )
  SELECT path.id, m.at, m.role, m.kind,
    CASE WHEN m.kind = 'text' THEN m.text END AS text,
    json_extract(m.json, '$.image') AS image,
    json_extract(m.json, '$.summarized') AS summarized,
    json_extract(m.json, '$.roomEcho') AS roomEcho
  FROM path LEFT JOIN messages m ON path.depth < ?3 AND m.thread_id = ?1 AND m.id = path.id
    AND (json_extract(m.json, '$.image') IS NOT NULL OR (m.kind = 'text' AND
      CASE WHEN m.role = 'user' THEN instr(m.text, '<attached-') > 0
        ELSE instr(m.text, '](') > 0 OR instr(m.text, '![') > 0 END))
  WHERE m.id IS NOT NULL OR (path.depth = ?3 AND path.id IS NOT NULL)
  ORDER BY path.depth
`;

export function readMediaRows(threadId: string, cursor: string | null, limit: number, database?: DatabaseSync): { rows: MediaRow[]; next: string | null } {
  if (!cursor) return { rows: [], next: null };
  const statement = (database ?? messageDatabase()).prepare(SQL);
  // SAFETY: The SQL projects media fields and one row carrying the next page's id.
  const page = statement.all(threadId, cursor, limit) as PageRow[];
  const rows: MediaRow[] = [];
  let next: string | null = null;
  for (const row of page) {
    if (row.at === null) next = row.id;
    else rows.push({ ...row, text: row.text ?? undefined, image: row.image ?? undefined, summarized: Boolean(row.summarized) });
  }
  return { rows, next };
}
