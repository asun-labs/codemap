import type { DatabaseSync } from 'node:sqlite';

export interface GraphNode {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string | null;
  filePath: string | null;
  language: string | null;
  startLine: number | null;
  endLine: number | null;
}

export interface RawEdge {
  source: string;
  target: string;
  kind: string;
}

export interface LoadedGraph {
  nodes: Map<string, GraphNode>;
  edges: RawEdge[];
}

const BATCH = 5_000;

/** 按 rowid 分块遍历（避免一次性 all() 大表的内存峰值） */
function eachChunked(db: DatabaseSync, selectSql: string, cb: (row: Record<string, unknown>) => void): void {
  const stmt = db.prepare(`${selectSql} WHERE rowid > ? ORDER BY rowid LIMIT ?`);
  let last = 0;
  for (;;) {
    const rows = stmt.all(last, BATCH) as Array<Record<string, unknown>>;
    if (rows.length === 0) break;
    for (const row of rows) {
      cb(row);
      last = Number(row['_rid']);
    }
  }
}

/** 从镜像库加载全图（40 万边量级亚秒级） */
export function loadGraph(db: DatabaseSync): LoadedGraph {
  const nodes = new Map<string, GraphNode>();
  eachChunked(
    db,
    'SELECT rowid AS _rid, id, kind, name, qualified_name, file_path, language, start_line, end_line FROM nodes',
    (row) => {
      const id = String(row['id']);
      nodes.set(id, {
        id,
        kind: String(row['kind'] ?? ''),
        name: String(row['name'] ?? ''),
        qualifiedName: (row['qualified_name'] as string | null) ?? null,
        filePath: (row['file_path'] as string | null) ?? null,
        language: (row['language'] as string | null) ?? null,
        startLine: (row['start_line'] as number | null) ?? null,
        endLine: (row['end_line'] as number | null) ?? null,
      });
    },
  );
  const edges: RawEdge[] = [];
  eachChunked(db, 'SELECT rowid AS _rid, source, target, kind FROM edges', (row) => {
    edges.push({
      source: String(row['source']),
      target: String(row['target']),
      kind: String(row['kind'] ?? ''),
    });
  });
  return { nodes, edges };
}
