import { openOwnDb } from '../db/own.js';
import { loadGraph, type LoadedGraph } from './graph-load.js';
import { SYMBOL_KINDS } from './map-fold.js';
import { buildL4Index } from './adapters.js';
import { resolveProject } from '../util/paths.js';

const IMPACT_KINDS = new Set(['calls', 'instantiates', 'extends', 'implements', 'references', 'imports', 'l4-route']);

export interface ImpactHit {
  id: string;
  name: string;
  kind: string;
  file: string | null;
  line: number | null;
  dist: number;
}

export interface ImpactReport {
  projectPath: string;
  target: { id: string; name: string; kind: string; file: string | null };
  impacted: ImpactHit[];
  entryHits: Array<{ id: string; label: string; kind: string; filePath: string; line: number }>;
  truncated: boolean;
  note?: string;
}

/**
 * P5 impact：反向可达（谁会影响到它）+ L4 放大（受影响的路由/IPC 入口）。
 * l4-route 边（route→符号）反向参与：符号受影响 → 其入口受影响。
 */
export function impactAnalysis(projectInput: string, symbolRef: string, opts: { depth?: number } = {}): ImpactReport {
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

  // 注入 L4 节点与缝合边（放大用）
  const l4 = buildL4Index(projectPath, g);
  for (const n of l4.nodes) {
    g.nodes.set(n.id, {
      id: n.id,
      kind: n.kind,
      name: n.label,
      qualifiedName: null,
      filePath: n.filePath,
      language: null,
      startLine: n.line,
      endLine: n.line,
    });
  }
  for (const e of l4.edges) g.edges.push({ source: e.source, target: e.target, kind: e.kind });

  // 目标解析：符号 id / 唯一名
  let targetId: string | undefined = g.nodes.has(symbolRef) ? symbolRef : undefined;
  if (!targetId) {
    const hits = [...g.nodes.values()].filter((n) => SYMBOL_KINDS.has(n.kind) && (n.name === symbolRef || n.qualifiedName === symbolRef));
    if (hits.length === 1) targetId = (hits[0] as { id: string }).id;
    if (hits.length > 1) {
      throw new Error(`符号 '${symbolRef}' 命中 ${hits.length} 个（歧义），用节点 id: ${hits.slice(0, 5).map((h) => h.id).join(', ')}`);
    }
    if (!targetId) throw new Error(`符号未找到: ${symbolRef}（用 codemap_search 查名）`);
  }
  const targetNode = g.nodes.get(targetId);

  // 反向 BFS
  const reverse = new Map<string, string[]>();
  for (const e of g.edges) {
    if (!IMPACT_KINDS.has(e.kind)) continue;
    const arr = reverse.get(e.target) ?? [];
    arr.push(e.source);
    reverse.set(e.target, arr);
  }
  const maxDepth = opts.depth ?? 10;
  const dist = new Map<string, number>([[targetId, 0]]);
  let frontier = [targetId];
  let truncated = false;
  for (let d = 1; d <= maxDepth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const src of reverse.get(cur) ?? []) {
        if (!dist.has(src)) {
          dist.set(src, d);
          next.push(src);
        }
      }
    }
    frontier = next;
  }
  if (frontier.length > 0) truncated = true;

  const impacted: ImpactHit[] = [...dist.entries()]
    .filter(([id]) => id !== targetId)
    .map(([id, d]) => {
      const n = g.nodes.get(id);
      return { id, name: n?.name ?? id, kind: n?.kind ?? '?', file: n?.filePath ?? null, line: n?.startLine ?? null, dist: d };
    })
    .sort((a, b) => a.dist - b.dist || a.id.localeCompare(b.id));

  const entryHits = impacted
    .filter((h) => h.kind === 'route' || h.kind === 'ipc')
    .map((h) => ({
      id: h.id,
      label: h.name,
      kind: h.kind,
      filePath: h.file ?? '',
      line: h.line ?? 0,
    }));

  return {
    projectPath,
    target: { id: targetId, name: targetNode?.name ?? targetId, kind: targetNode?.kind ?? '?', file: targetNode?.filePath ?? null },
    impacted,
    entryHits,
    truncated,
    note: truncated ? `反向传播深度达上限 ${maxDepth}，结果可能不完整` : undefined,
  };
}
