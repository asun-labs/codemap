import type { LoadedGraph, GraphNode } from './graph-load.js';

export type MapLevel = 'system' | 'module' | 'symbol';

export interface MapNode {
  key: string;
  label: string;
  parent: string | null;
  fileCount: number;
  symbolCount: number;
  inDeg: number;
  outDeg: number;
}

export interface MapEdge {
  source: string;
  target: string;
  weight: number;
  kinds: Record<string, number>;
}

export interface FoldedMap {
  level: MapLevel;
  nodes: MapNode[];
  edges: MapEdge[];
  truncated: boolean;
  notes: string[];
}

/** codegraph 的结构符号种类（file/import 除外） */
export const SYMBOL_KINDS = new Set([
  'function', 'method', 'class', 'interface', 'type_alias',
  'variable', 'constant', 'component', 'struct',
]);

const MAX_DIR_DEPTH = 8;
const ROOT_KEY = '(root)';

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function isNodeModules(fp: string): boolean {
  const s = toPosix(fp);
  return s === 'node_modules' || s.startsWith('node_modules/') || s.includes('/node_modules/');
}

function posixDir(fp: string): string {
  const s = toPosix(fp);
  const i = s.lastIndexOf('/');
  return i < 0 ? '' : s.slice(0, i);
}

function topDir(fp: string): string {
  const dir = posixDir(fp);
  if (dir === '') return ROOT_KEY;
  return dir.split('/')[0] ?? ROOT_KEY;
}

function dirAtDepth(fp: string, d: number): string {
  const dir = posixDir(fp);
  if (dir === '') return ROOT_KEY;
  return dir.split('/').slice(0, d).join('/') || ROOT_KEY;
}

export interface FoldOptions {
  level: MapLevel;
  maxNodes: number;
  scopePath?: string;
  focus?: string;
  depth?: number;
}

type Mode = { kind: 'symbol' } | { kind: 'file' } | { kind: 'dir'; depth: number };

interface UnitAcc {
  key: string;
  labelBase: string;
  parent: string | null;
  files: Set<string>;
  symbols: number;
}

/**
 * 自适应聚合折叠（v2 §6.3）：
 * 阶梯 symbol → file → dir(自适应深度)，取不超 maxNodes 的最细粒度；
 * 目录粒度仍超限 → 低连接度单元折叠为 (other) 并标 truncated。
 */
export function foldGraph(g: LoadedGraph, opts: FoldOptions): FoldedMap {
  const notes: string[] = [];
  let truncated = false;
  const maxNodes = Math.max(1, opts.maxNodes);

  // 1) 参与节点：排除 import 伪节点、node_modules（默认），scope 过滤
  const participating = new Map<string, GraphNode>();
  for (const n of g.nodes.values()) {
    if (n.kind === 'import') continue;
    if (!n.filePath) continue;
    if (isNodeModules(n.filePath)) continue;
    if (opts.scopePath) {
      const fp = toPosix(n.filePath);
      const sp = toPosix(opts.scopePath).replace(/\/+$/, '');
      if (fp !== sp && !fp.startsWith(sp + '/')) continue;
    }
    participating.set(n.id, n);
  }
  if (participating.size === 0) {
    return { level: opts.level, nodes: [], edges: [], truncated: false, notes: ['范围内没有可绘制的节点'] };
  }

  const countUnits = (mode: Mode): number => {
    const set = new Set<string>();
    for (const n of participating.values()) {
      if (mode.kind === 'symbol') {
        if (SYMBOL_KINDS.has(n.kind)) set.add(n.id);
      } else {
        set.add(mode.kind === 'file' ? toPosix(n.filePath as string) : dirAtDepth(n.filePath as string, mode.depth));
      }
    }
    return set.size;
  };

  // 2) 粒度选择
  let mode: Mode;
  if (opts.level === 'system') {
    let chosen: Mode | undefined;
    for (let d = MAX_DIR_DEPTH; d >= 1; d--) {
      const m: Mode = { kind: 'dir', depth: d };
      if (countUnits(m) <= maxNodes) {
        chosen = m;
        break; // 从最深开始，第一个满足的就是最细的目录粒度
      }
    }
    mode = chosen ?? { kind: 'dir', depth: 1 };
    if (!chosen) notes.push(`目录数超出 maxNodes=${maxNodes}，低连接度目录折叠为 (other)`);
  } else if (opts.level === 'module') {
    if (countUnits({ kind: 'file' }) <= maxNodes) {
      mode = { kind: 'file' };
    } else {
      notes.push(`文件数超出 maxNodes=${maxNodes}，已按目录折叠`);
      mode = chooseDirMode(participating, maxNodes, notes);
    }
  } else {
    if (countUnits({ kind: 'symbol' }) <= maxNodes) {
      mode = { kind: 'symbol' };
    } else if (countUnits({ kind: 'file' }) <= maxNodes) {
      mode = { kind: 'file' };
      notes.push('符号数超出 maxNodes，已按文件折叠');
    } else {
      mode = chooseDirMode(participating, maxNodes, notes);
      notes.push('符号与文件数均超出 maxNodes，已按目录折叠');
    }
  }

  // 3) 构建单元
  const units = new Map<string, UnitAcc>();
  const unitOfNode = new Map<string, string>();
  const dirDepth = mode.kind === 'dir' ? mode.depth : 0;
  for (const n of participating.values()) {
    let key: string;
    let parent: string | null = null;
    if (mode.kind === 'symbol') {
      if (!SYMBOL_KINDS.has(n.kind)) continue;
      key = n.id;
    } else if (mode.kind === 'file') {
      key = toPosix(n.filePath as string);
      parent = topDir(n.filePath as string);
    } else {
      key = dirAtDepth(n.filePath as string, dirDepth);
      if (key !== ROOT_KEY) {
        const parts = key.split('/');
        parent = parts.length >= dirDepth && dirDepth > 1 ? parts.slice(0, dirDepth - 1).join('/') : null;
      }
    }
    unitOfNode.set(n.id, key);
    let u = units.get(key);
    if (!u) {
      u = { key, labelBase: key, parent, files: new Set<string>(), symbols: 0 };
      units.set(key, u);
    }
    if (SYMBOL_KINDS.has(n.kind)) u.symbols++;
    u.files.add(toPosix(n.filePath as string));
  }

  // 4) 边聚合（contains 只在符号级有意义；自环丢弃）
  const agg = new Map<string, MapEdge>();
  for (const e of g.edges) {
    if (e.kind === 'contains' && mode.kind !== 'symbol') continue;
    const s = unitOfNode.get(e.source);
    const t = unitOfNode.get(e.target);
    if (!s || !t || s === t) continue;
    const k = `${s}\u0000${t}`;
    let m = agg.get(k);
    if (!m) {
      m = { source: s, target: t, weight: 0, kinds: {} };
      agg.set(k, m);
    }
    m.weight++;
    m.kinds[e.kind] = (m.kinds[e.kind] ?? 0) + 1;
  }

  // 5) focus + depth 过滤（无向 BFS，保留边的方向）
  let keptEdges = [...agg.values()];
  if (opts.focus) {
    const start = matchFocus(units, opts.focus);
    const depth = opts.depth ?? 3;
    const adj = new Map<string, Set<string>>();
    for (const e of agg.values()) {
      pushAdj(adj, e.source, e.target);
      pushAdj(adj, e.target, e.source);
    }
    const visited = new Set<string>([start]);
    let frontier = [start];
    for (let d = 0; d < depth && frontier.length > 0; d++) {
      const next: string[] = [];
      for (const cur of frontier) {
        for (const nb of adj.get(cur) ?? []) {
          if (!visited.has(nb)) {
            visited.add(nb);
            next.push(nb);
          }
        }
      }
      frontier = next;
    }
    for (const key of [...units.keys()]) {
      if (!visited.has(key)) units.delete(key);
    }
    keptEdges = keptEdges.filter((e) => visited.has(e.source) && visited.has(e.target));
  }

  // 6) 度数
  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  for (const e of keptEdges) {
    outDeg.set(e.source, (outDeg.get(e.source) ?? 0) + e.weight);
    inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + e.weight);
  }

  // 7) 超限折叠（focus/其他路径下仍超 maxNodes 时）
  if (units.size > maxNodes) {
    truncated = true;
    if (!notes.some((s) => s.includes('(other)'))) {
      notes.push(`单元数 ${units.size} 超出 maxNodes=${maxNodes}，低连接度单元折叠为 (other)`);
    }
    const deg = new Map<string, number>();
    for (const key of units.keys()) deg.set(key, 0);
    for (const e of keptEdges) {
      deg.set(e.source, (deg.get(e.source) ?? 0) + e.weight);
      deg.set(e.target, (deg.get(e.target) ?? 0) + e.weight);
    }
    const keep = new Set(
      [...units.keys()].sort((a, b) => (deg.get(b) ?? 0) - (deg.get(a) ?? 0)).slice(0, Math.max(1, maxNodes - 1)),
    );
    const OTHER = '(other)';
    const otherAcc: UnitAcc = { key: OTHER, labelBase: OTHER, parent: null, files: new Set(), symbols: 0 };
    for (const [key, u] of units) {
      if (!keep.has(key)) {
        otherAcc.symbols += u.symbols;
        for (const f of u.files) otherAcc.files.add(f);
        units.delete(key);
      }
    }
    units.set(OTHER, otherAcc);
    const redirected = new Map<string, MapEdge>();
    for (const e of keptEdges) {
      const s = keep.has(e.source) ? e.source : OTHER;
      const t = keep.has(e.target) ? e.target : OTHER;
      if (s === t) continue;
      const k = `${s}\u0000${t}`;
      const m = redirected.get(k) ?? { source: s, target: t, weight: 0, kinds: {} };
      m.weight += e.weight;
      for (const [kk, vv] of Object.entries(e.kinds)) m.kinds[kk] = (m.kinds[kk] ?? 0) + vv;
      redirected.set(k, m);
    }
    keptEdges = [...redirected.values()];
    for (const key of [...inDeg.keys(), ...outDeg.keys()]) {
      if (!keep.has(key) && key !== OTHER) {
        inDeg.delete(key);
        outDeg.delete(key);
      }
    }
    for (const e of keptEdges) {
      outDeg.set(e.source, (outDeg.get(e.source) ?? 0) + e.weight);
      inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + e.weight);
    }
  }

  // 8) 输出（按度数降序，稳定）
  const nodes: MapNode[] = [...units.values()]
    .map((u) => {
      const suffix =
        mode.kind === 'dir' ? ` (+${u.files.size} files)` : mode.kind === 'file' ? ` (+${u.symbols})` : '';
      return {
        key: u.key,
        label: `${u.labelBase}${suffix}`,
        parent: u.parent,
        fileCount: u.files.size,
        symbolCount: u.symbols,
        inDeg: inDeg.get(u.key) ?? 0,
        outDeg: outDeg.get(u.key) ?? 0,
      };
    })
    .sort((a, b) => b.inDeg + b.outDeg - (a.inDeg + a.outDeg) || a.key.localeCompare(b.key));

  return {
    level: opts.level,
    nodes,
    edges: keptEdges.sort((a, b) => b.weight - a.weight || a.source.localeCompare(b.source)),
    truncated,
    notes,
  };
}

function chooseDirMode(
  participating: Map<string, GraphNode>,
  maxNodes: number,
  notes: string[],
): Mode {
  for (let d = MAX_DIR_DEPTH; d >= 1; d--) {
    const m: Mode = { kind: 'dir', depth: d };
    let count = 0;
    const set = new Set<string>();
    for (const n of participating.values()) set.add(dirAtDepth(n.filePath as string, d));
    count = set.size;
    if (count <= maxNodes) return m;
  }
  return { kind: 'dir', depth: 1 };
}

function pushAdj(adj: Map<string, Set<string>>, a: string, b: string): void {
  let s = adj.get(a);
  if (!s) {
    s = new Set();
    adj.set(a, s);
  }
  s.add(b);
}

/** focus 匹配：key 精确 → 后缀唯一 → label 精确；歧义报候选 */
function matchFocus(units: Map<string, UnitAcc>, focus: string): string {
  if (units.has(focus)) return focus;
  const f = toPosix(focus).replace(/\/+$/, '');
  const suffixHits = [...units.keys()].filter((k) => k === f || k.endsWith(`/${f}`));
  const labelHits = [...units.values()].filter((u) => u.labelBase === focus).map((u) => u.key);
  const candidates = [...new Set([...suffixHits, ...labelHits])];
  if (candidates.length === 1) return candidates[0] as string;
  if (candidates.length === 0) {
    throw new Error(`focus 未找到: ${focus}（可用: ${[...units.keys()].slice(0, 10).join(', ')}${units.size > 10 ? ' …' : ''}）`);
  }
  throw new Error(`focus 歧义，候选: ${candidates.slice(0, 10).join(', ')}`);
}
