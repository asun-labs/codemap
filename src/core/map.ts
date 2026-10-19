import { openOwnDb } from '../db/own.js';
import { deliverPayload, type PayloadDelivery } from '../db/projections.js';
import { loadGraph } from './graph-load.js';
import { foldGraph, type MapLevel } from './map-fold.js';
import { renderDot, renderJson, renderMermaid } from './map-render.js';

export type MapFormat = 'mermaid' | 'dot' | 'json';

export interface MapParams {
  level?: MapLevel;
  maxNodes?: number;
  focus?: string;
  depth?: number;
  format?: MapFormat;
  scope?: string;
}

export interface MapResult {
  format: MapFormat;
  delivery: PayloadDelivery;
  summary: string;
  stats: { level: MapLevel; nodes: number; edges: number; truncated: boolean; notes: string[] };
}

/**
 * P1 map：镜像图 → 自适应折叠 → mermaid/dot/json（v2 §6.3 / §7 codemap_map）。
 * scope: project | module:<路径>
 */
export function buildMap(projectPath: string, params: MapParams = {}): MapResult {
  const level: MapLevel = params.level ?? 'system';
  const maxNodes = params.maxNodes ?? 60;
  const format: MapFormat = params.format ?? 'mermaid';
  let scopePath: string | undefined;
  const scope = params.scope?.trim();
  if (scope && scope !== 'project') {
    if (!scope.startsWith('module:')) {
      throw new Error(`scope 仅支持 project | module:<路径>（feature/boundary 随 P2/P5 提供），收到: ${scope}`);
    }
    scopePath = scope.slice('module:'.length);
    if (!scopePath) throw new Error('scope module:<路径> 缺少路径');
  }

  const db = openOwnDb(projectPath);
  try {
    const g = loadGraph(db);
    const folded = foldGraph(g, { level, maxNodes, scopePath, focus: params.focus, depth: params.depth });
    if (folded.nodes.length === 0) {
      throw new Error(`map 无内容: ${folded.notes.join('; ') || '范围内没有节点'}`);
    }
    const payload =
      format === 'mermaid' ? renderMermaid(folded) : format === 'dot' ? renderDot(folded) : renderJson(folded);
    const summary =
      `${folded.nodes.length} 节点 · ${folded.edges.length} 边 · level=${level}` +
      (folded.notes.length ? ` · ${folded.notes.join('; ')}` : '');
    const delivery = deliverPayload(db, payload, summary);
    return {
      format,
      delivery,
      summary,
      stats: { level, nodes: folded.nodes.length, edges: folded.edges.length, truncated: folded.truncated, notes: folded.notes },
    };
  } finally {
    try {
      db.close();
    } catch {
      /* 已关闭则忽略 */
    }
  }
}
