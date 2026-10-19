import { openOwnDb } from '../db/own.js';
import { loadGraph, type LoadedGraph } from './graph-load.js';
import { resolveProject } from '../util/paths.js';
import { SYMBOL_KINDS } from './map-fold.js';

export interface TraceStep {
  id: string;
  name: string;
  kind: string;
  file: string | null;
  line: number | null;
}

export interface TraceResult {
  projectPath: string;
  from: string;
  to: string;
  found: boolean;
  hops: number;
  path: TraceStep[];
  edgeKinds: string[];
  undirected: boolean;
  note?: string;
}

/** 遍历用的结构边（contains 是层级关系，不参与路径） */
const TRAVERSAL_KINDS = new Set(['calls', 'instantiates', 'extends', 'implements', 'references', 'imports']);

/**
 * P3 trace（v2 §7）：镜像图上的有向最短路径（BFS）。
 * 先按调用方向找；找不到时可用 undirected 回退（注明）。缝上的 pierce 边随 P3 pierce 缓存扩展。
 */
export function tracePath(
  projectInput: string,
  from: string,
  to: string,
  opts: { undirected?: boolean } = {},
): TraceResult {
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

  const start = resolveNode(g, from, 'from');
  const goal = resolveNode(g, to, 'to');

  const attempt = (undirected: boolean): string[] | null => {
    const adj = new Map<string, Array<{ to: string; kind: string }>>();
    for (const e of g.edges) {
      if (!TRAVERSAL_KINDS.has(e.kind)) continue;
      push(adj, e.source, { to: e.target, kind: e.kind });
      if (undirected) push(adj, e.target, { to: e.source, kind: e.kind });
    }
    const prev = new Map<string, { node: string; kind: string }>();
    const seen = new Set<string>([start]);
    let frontier = [start];
    for (;;) {
      const next: string[] = [];
      for (const cur of frontier) {
        for (const e of adj.get(cur) ?? []) {
          if (seen.has(e.to)) continue;
          seen.add(e.to);
          prev.set(e.to, { node: cur, kind: e.kind });
          if (e.to === goal) {
            // 回溯
            const path: string[] = [goal];
            const kinds: string[] = [];
            let cur2 = goal;
            while (cur2 !== start) {
              const p = prev.get(cur2);
              if (!p) break;
              kinds.push(p.kind);
              cur2 = p.node;
              path.push(cur2);
            }
            pathIds = path.reverse();
            pathKinds = kinds.reverse();
            return pathIds;
          }
          next.push(e.to);
        }
      }
      if (next.length === 0) return null;
      frontier = next;
    }
  };

  let pathIds: string[] = [];
  let pathKinds: string[] = [];
  let usedUndirected = false;
  if (attempt(false) === null && opts.undirected !== false) {
    pathIds = [];
    pathKinds = [];
    if (attempt(true) !== null) usedUndirected = true;
  }

  const found = pathIds.length > 0;
  const step = (id: string): TraceStep => {
    const n = g.nodes.get(id);
    return {
      id,
      name: n?.name ?? id,
      kind: n?.kind ?? '?',
      file: n?.filePath ?? null,
      line: n?.startLine ?? null,
    };
  };

  return {
    projectPath,
    from: start,
    to: goal,
    found,
    hops: found ? pathIds.length - 1 : 0,
    path: found ? pathIds.map(step) : [],
    edgeKinds: pathKinds,
    undirected: usedUndirected,
    note: found
      ? usedUndirected
        ? '有向图上不可达，以下为无向回退路径'
        : undefined
      : '有向与无向均不可达（或其中一端不在结构边上）',
  };
}

function resolveNode(g: LoadedGraph, ref: string, which: string): string {
  if (g.nodes.has(ref)) return ref;
  const byName = [...g.nodes.values()].filter(
    (n) => SYMBOL_KINDS.has(n.kind) && (n.name === ref || n.qualifiedName === ref),
  );
  if (byName.length === 1) return (byName[0] as { id: string }).id;
  if (byName.length > 1) {
    throw new Error(
      `${which}='${ref}' 命中 ${byName.length} 个符号（歧义），请用节点 id: ${byName
        .slice(0, 5)
        .map((n) => `${n.id}(${n.filePath})`)
        .join(', ')}`,
    );
  }
  throw new Error(`${which}='${ref}' 未找到（可用 codemap_search 查名，或用节点 id）`);
}

function push(adj: Map<string, Array<{ to: string; kind: string }>>, a: string, e: { to: string; kind: string }): void {
  const arr = adj.get(a) ?? [];
  arr.push(e);
  adj.set(a, arr);
}
