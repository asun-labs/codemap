import { openOwnDb } from '../db/own.js';
import { loadGraph, type LoadedGraph, type GraphNode } from './graph-load.js';
import { resolveProject } from '../util/paths.js';

export interface SearchHit {
  id: string;
  name: string;
  kind: string;
  filePath: string | null;
  line: number | null;
}

/** 薄封装：镜像符号名 LIKE 检索（token 预算内返回 top-N） */
export function searchNodes(projectInput: string, query: string, limit = 20): Array<SearchHit> {
  const projectPath = resolveProject(projectInput);
  const db = openOwnDb(projectPath);
  try {
    const like = `%${escapeLike(query)}%`;
    const rows = db
      .prepare(
        `SELECT id, kind, name, file_path, start_line FROM nodes
         WHERE name LIKE ? ESCAPE '\\' OR qualified_name LIKE ? ESCAPE '\\'
         ORDER BY CASE kind WHEN 'function' THEN 0 WHEN 'method' THEN 1 WHEN 'class' THEN 2 ELSE 3 END, name
         LIMIT ?`,
      )
      .all(like, like, limit) as Array<{ id: string; kind: string; name: string; file_path: string | null; start_line: number | null }>;
    return rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, filePath: r.file_path, line: r.start_line }));
  } finally {
    try {
      db.close();
    } catch {
      /* 已关闭则忽略 */
    }
  }
}

export interface OutlineResult {
  node: SearchHit & { qualifiedName: string | null; language: string | null; endLine: number | null };
  parents: SearchHit[];
  children: SearchHit[];
}

/** 薄封装：节点 + contains 层级（父容器 / 子成员） */
export function outlineNode(projectInput: string, nodeRef: string): OutlineResult {
  const projectPath = resolveProject(projectInput);
  const db = openOwnDb(projectPath);
  let g: LoadedGraph;
  try {
    g = loadGraph(db);
  } finally {
    try {
      db.close();
    } catch {
      /* 已关闭则忽略 */
    }
  }
  let id: string | undefined = g.nodes.has(nodeRef) ? nodeRef : undefined;
  if (!id) {
    const hits = [...g.nodes.values()].filter((n) => n.name === nodeRef || n.qualifiedName === nodeRef);
    if (hits.length === 1) id = (hits[0] as { id: string }).id;
    if (hits.length > 1) {
      throw new Error(`'${nodeRef}' 命中 ${hits.length} 个节点（歧义），用节点 id`);
    }
    if (!id) throw new Error(`节点未找到: ${nodeRef}（用 codemap_search 查名）`);
  }
  const n = g.nodes.get(id) as GraphNode;
  const hit = (x: { id: string; kind: string; name: string; filePath: string | null; startLine: number | null }): SearchHit => ({
    id: x.id,
    name: x.name,
    kind: x.kind,
    filePath: x.filePath,
    line: x.startLine,
  });
  const parents: SearchHit[] = [];
  const children: SearchHit[] = [];
  for (const e of g.edges) {
    if (e.kind !== 'contains') continue;
    if (e.target === id) {
      const p = g.nodes.get(e.source);
      if (p) parents.push(hit({ ...p, filePath: p.filePath, startLine: p.startLine }));
    }
    if (e.source === id) {
      const c = g.nodes.get(e.target);
      if (c) children.push(hit({ ...c, filePath: c.filePath, startLine: c.startLine }));
    }
  }
  return {
    node: {
      id: n.id,
      name: n.name,
      kind: n.kind,
      filePath: n.filePath,
      line: n.startLine,
      qualifiedName: n.qualifiedName,
      language: n.language,
      endLine: n.endLine,
    },
    parents: parents.sort((a, b) => a.name.localeCompare(b.name)),
    children: children.sort((a, b) => (a.line ?? 0) - (b.line ?? 0)),
  };
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
