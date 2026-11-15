import type { Confidence, Evidence, GraphEdge, GraphNode, Level, NodeKind } from '../model/schema.js';
import { isExcludedPath, isTestFile, type RawEdge, type RawNode, type UpstreamGraph } from '../codegraph/reader.js';
import type { RepoDetection } from './detect-repo.js';

/** 参与「结构骨架」的边：calls / instantiates / extends / implements / references */
const DEPENDENCY_KINDS = new Set(['calls', 'instantiates', 'extends', 'implements', 'references']);
/** imports 单独处理：它是文件级/系统级的强信号，但会淹没 calls */
const IMPORT_KIND = 'imports';

export interface FileInfo {
  path: string;
  language: string;
  symbols: number;
  /** 文件级依赖出度（去重后的目标文件数） */
  outFiles: Set<string>;
  /** 文件级依赖入度 */
  inFiles: Set<string>;
  lines: number;
}

export interface FileGraph {
  files: Map<string, FileInfo>;
  /** 文件 → 文件 的边（聚合后） */
  edges: Array<{ source: string; target: string; weight: number; kinds: Record<string, number>; line: number | null }>;
  stats: {
    totalFiles: number;
    keptFiles: number;
    testsFiltered: number;
    excludedFiltered: number;
    symbols: number;
    unresolvedRefs: number;
    resolvedEdges: number;
  };
}

export interface BuildOptions {
  /** 是否包含测试文件（默认 false） */
  includeTests?: boolean;
  /** 模块层单节点子目录阈值：超过则继续按目录展开 */
  branchThreshold?: number;
  /** 列在根下的零散文件聚合成的节点名 */
  looseFolderLabel?: string;
}

const DEFAULT_BRANCH_THRESHOLD = 6;

/** 从 codegraph 原始图派生「文件级图」：一次 O(E) 扫描完成过滤与聚合 */
export function buildFileGraph(up: UpstreamGraph, opts: BuildOptions = {}): FileGraph {
  const includeTests = opts.includeTests === true;

  // 1) 文件节点 → 保留哪些文件
  const files = new Map<string, FileInfo>();
  const nodeToFile = new Map<string, string>();
  let testsFiltered = 0;
  let excludedFiltered = 0;
  let totalFiles = 0;

  for (const n of up.nodes.values()) {
    if (n.kind !== 'file' || n.filePath === '') continue;
    totalFiles++;
    const p = n.filePath.replace(/\\/g, '/');
    if (isExcludedPath(p)) {
      excludedFiltered++;
      continue;
    }
    if (!includeTests && isTestFile(p)) {
      testsFiltered++;
      continue;
    }
    files.set(p, {
      path: p,
      language: n.language || 'unknown',
      symbols: 0,
      outFiles: new Set(),
      inFiles: new Set(),
      lines: Math.max(0, n.endLine - n.startLine + 1),
    });
  }

  // 2) 符号 → 所在文件（用于把符号级边提升到文件级）
  let symbols = 0;
  for (const n of up.nodes.values()) {
    if (n.kind === 'file' || n.filePath === '') continue;
    const p = n.filePath.replace(/\\/g, '/');
    if (!files.has(p)) continue;
    nodeToFile.set(n.id, p);
    if (n.kind !== 'import') {
      symbols++;
      const f = files.get(p);
      if (f) f.symbols++;
    }
  }
  // 文件节点自身也映射到自己
  for (const p of files.keys()) nodeToFile.set(`file:${p}`, p);

  // 3) 边聚合到文件级
  const acc = new Map<string, { source: string; target: string; weight: number; kinds: Record<string, number>; line: number | null }>();
  let resolvedEdges = 0;
  const importTargets = new Map<string, Set<string>>();

  const addEdge = (s: string, t: string, kind: string, line: number | null) => {
    if (s === t) return;
    resolvedEdges++;
    const key = `${s}\u0000${t}`;
    let e = acc.get(key);
    if (!e) {
      e = { source: s, target: t, weight: 0, kinds: {}, line };
      acc.set(key, e);
    }
    e.weight++;
    e.kinds[kind] = (e.kinds[kind] ?? 0) + 1;
    if (e.line == null && line != null) e.line = line;
  };

  for (const e of up.edges) {
    const s = nodeToFile.get(e.source);
    const t = nodeToFile.get(e.target);
    if (e.kind === IMPORT_KIND) {
      if (!s) continue;
      const targetNode = up.nodes.get(e.target);
      if (!targetNode) continue;
      // imports 的目标是 import 伪节点（模块名）或具体符号
      if (targetNode.kind === 'import') {
        const resolved = resolveImportSpec(s, targetNode.name, files);
        if (resolved) {
          importTargets.get(s)?.add(resolved) ?? importTargets.set(s, new Set([resolved]));
          if (resolved !== s) {
            addEdge(s, resolved, 'imports', e.line);
          }
        }
      } else if (t) {
        addEdge(s, t, 'imports', e.line);
      }
      continue;
    }
    if (!DEPENDENCY_KINDS.has(e.kind)) continue;
    if (!s || !t) continue;
    addEdge(s, t, e.kind, e.line);
  }

  // 4) 度数回填
  for (const e of acc.values()) {
    files.get(e.source)?.outFiles.add(e.target);
    files.get(e.target)?.inFiles.add(e.source);
  }

  return {
    files,
    edges: [...acc.values()],
    stats: {
      totalFiles,
      keptFiles: files.size,
      testsFiltered,
      excludedFiltered,
      symbols,
      unresolvedRefs: up.unresolved.length,
      resolvedEdges,
    },
  };
}

/**
 * 把 import 说明符解析成仓库内文件路径。
 * 覆盖 TS/JS 的 ESM 与 CJS 常见形态 + Python dotted module；解析不到返回 null（进盲区统计）。
 */
export function resolveImportSpec(fromFile: string, spec: string, files: Map<string, unknown>): string | null {
  // Python: from a.b import c / import a.b
  if (!spec.startsWith('.') && !spec.startsWith('/') && !spec.includes('/') && /^\w+(\.\w+)*$/.test(spec) && !spec.startsWith('node:')) {
    const parts = spec.split('.');
    const base = parts.join('/');
    for (const cand of [`${base}.py`, `${base}/__init__.py`]) {
      if (files.has(cand)) return cand;
    }
  }
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null; // 第三方/别名，留给盲区
  // Go 风格：路径是全模块相对，不在单文件 import 里
  const fromDir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
  const joinedRaw = spec.startsWith('/') ? spec.slice(1) : fromDir === '' ? spec : `${fromDir}/${spec}`;
  const joined = normalize(joinedRaw);
  const exts = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.py', '.go', '.rs'];
  for (const ext of exts) {
    const cand = joined + ext;
    if (files.has(cand)) return cand;
  }
  // TS 编译产物写法：./foo.js 实际源文件是 ./foo.ts
  const stripJs = joined.replace(/\.(js|jsx|mjs|cjs)$/, '');
  if (stripJs !== joined) {
    for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte']) {
      if (files.has(stripJs + ext)) return stripJs + ext;
    }
  }
  for (const ext of exts) {
    const cand = `${joined}/index${ext}`;
    if (files.has(cand)) return cand;
  }
  return null;
}

function normalize(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

/** 模块树：每个节点是一段目录（或零散文件桶） */
export interface ModuleTreeNode {
  /** 目录相对路径（posix）；零散文件桶为父目录 + '\u0000loose' */
  path: string;
  label: string;
  parent: string | null;
  /** 直接属于本目录的文件（不含子目录） */
  files: string[];
  children: ModuleTreeNode[];
  /** 子树里的全部文件数 */
  totalFiles: number;
  totalSymbols: number;
  isLoose: boolean;
}

export function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

export function baseOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

/**
 * 构建模块目录树（L2 用）。
 * 规则：目录层级逐级展开，某目录的直接子目录数 <= branchThreshold 时，其下的深层目录
 * 一并压成一个节点（避免 a/b/c/d 这种只含单一路径的链被拆成四层）。
 */
export function buildModuleTree(fg: FileGraph, opts: BuildOptions = {}): ModuleTreeNode {
  const threshold = opts.branchThreshold ?? DEFAULT_BRANCH_THRESHOLD;
  const rootNode: ModuleTreeNode = {
    path: '',
    label: '（根目录）',
    parent: null,
    files: [],
    children: [],
    totalFiles: 0,
    totalSymbols: 0,
    isLoose: false,
  };

  const ensure = (dir: string, parent: ModuleTreeNode | null): ModuleTreeNode => {
    // 逐段建目录链
    const segs = dir === '' ? [] : dir.split('/');
    let cur = rootNode;
    for (let i = 0; i < segs.length; i++) {
      const p = segs.slice(0, i + 1).join('/');
      let next = cur.children.find((c) => c.path === p);
      if (!next) {
        next = {
          path: p,
          label: segs[i] as string,
          parent: cur.path === '' ? '' : cur.path,
          files: [],
          children: [],
          totalFiles: 0,
          totalSymbols: 0,
          isLoose: false,
        };
        cur.children.push(next);
      }
      cur = next;
    }
    void parent;
    return cur;
  };

  for (const p of fg.files.keys()) {
    const dir = dirOf(p);
    const node = ensure(dir, null);
    node.files.push(p);
  }

  // 聚合统计 + 压链 + 零散文件成桶
  const finalize = (node: ModuleTreeNode): void => {
    node.totalFiles = node.files.length;
    node.totalSymbols = node.files.reduce((s, f) => s + (fg.files.get(f)?.symbols ?? 0), 0);
    for (const c of node.children) {
      finalize(c);
      node.totalFiles += c.totalFiles;
      node.totalSymbols += c.totalSymbols;
    }
    // 零散文件：目录里有子目录、且直接文件数很少 → 合成「（散文件）」
    if (node.children.length > 0 && node.files.length > 0 && node.files.length <= 3) {
      const loose: ModuleTreeNode = {
        path: node.path === '' ? '\u0000loose' : `${node.path}/\u0000loose`,
        label: '（散文件）',
        parent: node.path,
        files: node.files,
        children: [],
        totalFiles: node.files.length,
        totalSymbols: node.files.reduce((s, f) => s + (fg.files.get(f)?.symbols ?? 0), 0),
        isLoose: true,
      };
      node.children.push(loose);
      node.files = [];
    }
    // 压链：只有一个子目录且自己没有文件 → 合并父子
    if (
      node.children.length === 1 &&
      node.files.length === 0 &&
      node.path !== '' &&
      !(node.children[0] as ModuleTreeNode).isLoose &&
      countSiblings(node) <= threshold
    ) {
      const only = node.children[0] as ModuleTreeNode;
      node.path = only.path;
      node.label = only.label;
      node.files = only.files;
      node.children = only.children;
      for (const c of node.children) c.parent = node.path;
    }
  };
  const countSiblings = (n: ModuleTreeNode): number => n.children.length + (n.files.length > 0 ? 1 : 0);
  finalize(rootNode);
  return rootNode;
}

export interface NodeDraft {
  id: string;
  level: Level;
  kind: NodeKind;
  label: string;
  parent: string | null;
  path: string | null;
  hasChildren: boolean;
  childCount: number;
  childNodes: number;
  metrics: { files: number; symbols: number; crossEdges: number; languages: string[] };
  external: boolean;
  isCurrent?: boolean;
  notes?: string[];
}

export interface EdgeDraft {
  id: string;
  source: string;
  target: string;
  scope: 'internal' | 'system';
  kind: 'wire' | 'structure' | 'dependency';
  protocol: string;
  label: string;
  weight: number;
  kinds: Record<string, number>;
  confidence: Confidence;
  evidence: Evidence[];
}

/** 文件级依赖边 → 上层（目录/子系统/系统）聚合边 */
export function aggregateEdges(
  edges: FileGraph['edges'],
  levelOf: Map<string, string>,
  scope: 'internal' | 'system',
  confidence: Confidence = 'exact',
): EdgeDraft[] {
  const acc = new Map<string, EdgeDraft>();
  for (const e of edges) {
    const s = levelOf.get(e.source);
    const t = levelOf.get(e.target);
    if (!s || !t || s === t) continue;
    const key = `${s}\u0000${t}`;
    let d = acc.get(key);
    if (!d) {
      d = {
        id: `${scope}:${s}->${t}`,
        source: s,
        target: t,
        scope,
        kind: 'dependency',
        protocol: 'code',
        label: '',
        weight: 0,
        kinds: {},
        confidence,
        evidence: [],
      };
      acc.set(key, d);
    }
    d.weight += e.weight;
    for (const [k, v] of Object.entries(e.kinds)) d.kinds[k] = (d.kinds[k] ?? 0) + v;
    if (d.evidence.length < 3) d.evidence.push({ file: e.source, line: e.line ?? 0 });
  }
  // 主导协议写成线标签
  for (const d of acc.values()) {
    const top = Object.entries(d.kinds).sort((a, b) => b[1] - a[1])[0];
    d.label = top ? `${top[0]} ×${top[1]}` : '';
  }
  return [...acc.values()];
}

/** 让模块树节点在有向图上可有可无地重新挂 parent（压链后的修正） */
export function reindexParents(root: ModuleTreeNode): void {
  const walk = (n: ModuleTreeNode) => {
    for (const c of n.children) {
      c.parent = n.path;
      walk(c);
    }
  };
  walk(root);
}

export function rawNodeCount(up: UpstreamGraph): number {
  return up.nodes.size;
}

export function rawEdgeCount(up: UpstreamGraph): number {
  return up.edges.length;
}

export type { RawEdge, RawNode };
