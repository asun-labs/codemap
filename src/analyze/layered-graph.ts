import type {
  CodeMapGraph,
  EdgeKind,
  Evidence,
  GraphEdge,
  GraphNode,
  Level,
  NodeKind,
  ProjectInfo,
} from '../model/schema.js';
import type { UpstreamGraph } from '../codegraph/reader.js';
import type { RepoDetection } from './detect-repo.js';
import {
  aggregateEdges,
  buildFileGraph,
  buildModuleTree,
  dirOf,
  type FileGraph,
  type BuildOptions,
  type ModuleTreeNode,
} from './file-graph.js';
import { buildSystemsLayer, type ExternalSys } from './systems-layer.js';

export interface BuildInput {
  up: UpstreamGraph;
  detection: RepoDetection;
  project: ProjectInfo;
  options?: BuildOptions;
  /** systems.yaml 里人工确认的外部系统（优先于自动推测） */
  externalSystems?: ExternalSys[];
  /** 当前系统在 systems.yaml 里的展示名 */
  systemName?: string;
}

export interface BuildOutput {
  nodes: GraphNode[];
  edges: GraphEdge[];
  fileGraph: FileGraph;
  moduleTree: ModuleTreeNode;
  systemsWarnings: string[];
  /** 本次实际使用的外部系统（带 evidence），用于写 systems.yaml 建议稿 */
  externalSystems: ExternalSys[];
  /** 文件路径 → 文件节点 id（其它模块复用） */
  fileNodeId: Map<string, string>;
}

export const RESERVED_SYSTEM_IDS = ['__current__'];

/** 系统节点 id：当前系统固定，外部系统带前缀，避免与目录同名 */
export function systemNodeId(key: string): string {
  return key === '__current__' ? 'sys:__current__' : `sys:${key}`;
}

export function moduleNodeId(pkgDir: string | null, dirPath: string): string {
  const prefix = pkgDir ? `pkg:${pkgDir}` : 'mod';
  return `${prefix}/${dirPath === '' ? '.' : dirPath}`;
}

export function fileNodeId(p: string): string {
  return `file:${p}`;
}

/**
 * 分层图构建：L0 系统（跨系统骨架）→ L1 子系统 → L2 模块 → L3 文件。
 * 单包仓库跳过 L1，模块直接挂在系统下（schema 里已约定的简化）。
 */
export function buildLayeredGraph(input: BuildInput): BuildOutput {
  const { up, detection, project } = input;
  const opts = input.options ?? {};
  const warnings: string[] = [];

  const fg = buildFileGraph(up, opts);
  if (fg.stats.testsFiltered > 0) {
    warnings.push(`已过滤 ${fg.stats.testsFiltered} 个测试文件（按约定不进骨架）`);
  }
  if (fg.stats.unresolvedRefs > 0) {
    warnings.push(`${fg.stats.unresolvedRefs} 处符号引用未能解析，覆盖率见 project.stats.coverage`);
  }

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const fileIdOf = new Map<string, string>();
  for (const p of fg.files.keys()) fileIdOf.set(p, fileNodeId(p));

  // ——— 归属：文件 → 子系统包 → 零件链 ———
  const pkgOf = assignPackages(fg, detection);
  const level2Of = new Map<string, string>(); // 文件 → L2 节点 id
  const packages = detection.packages.filter((p) => p.dir !== '').sort((a, b) => b.dir.length - a.dir.length);
  const looseOfPkg = new Map<string, string[]>();

  // 单包：整体一个模块树，父节点是系统
  const currentId = systemNodeId('__current__');
  const singleTree = packages.length === 0;

  // 包内文件 → 该包的模块树（单包时只有一棵，pkgDir = null）
  const treeByPkg = new Map<string | null, { tree: ModuleTreeNode; files: string[] }>();
  if (singleTree) {
    const all = [...fg.files.keys()];
    const sub: FileGraph = { ...fg, files: filterFiles(fg, all) };
    treeByPkg.set(null, { tree: buildModuleTree(sub, opts), files: all });
  } else {
    for (const pkg of packages) {
      const files = [...fg.files.keys()].filter((p) => pkgOf.get(p) === pkg.dir);
      if (files.length === 0) continue;
      const sub: FileGraph = { ...fg, files: filterFiles(fg, files) };
      const prev = treeByPkg.get(pkg.dir);
      if (prev) {
        prev.files.push(...files);
      } else {
        treeByPkg.set(pkg.dir, { tree: buildModuleTree(sub, opts), files });
      }
    }
    // 不属于任何包的文件（根目录零散文件、scripts/ 等）
    const leftover = [...fg.files.keys()].filter((p) => !pkgOf.has(p));
    if (leftover.length > 0) {
      looseOfPkg.set('', leftover);
    }
  }

  // ——— L2/L3 生成 ———
  const fileNodes: GraphNode[] = [];
  const moduleNodes: GraphNode[] = [];
  const moduleById = new Map<string, GraphNode>();
  const fileNodeById = new Map<string, GraphNode>();
  const symbolsByFile = countSymbolsByFile(up, fg);

  /** 深拷贝模块树并重写 path 为相对仓库根的完整路径（单包时前缀为空） */
  const remapTree = (node: ModuleTreeNode, pkgDir: string | null): ModuleTreeNode => {
    const p = pkgDir === null ? node.path : node.path === '' ? pkgDir : `${pkgDir}/${node.path}`;
    return {
      ...node,
      path: p,
      children: node.children.map((c) => remapTree(c, pkgDir)),
    };
  };

  /** 一次性递归落盘一棵（已重写路径的）模块树，同时登记文件归属 */
  const emitNode = (node: ModuleTreeNode, parentId: string): void => {
    const id = moduleNodeId(null, node.path);
    const directFiles = node.files.map(fileNodeId).filter((fid) => fileNodeById.has(fid));
    const childIds: string[] = [];
    for (const c of node.children) {
      const cid = moduleNodeId(null, c.path);
      childIds.push(cid);
      emitNode(c, id);
    }
    const files = collectFiles({ ...node, path: node.path });
    const node0: GraphNode = {
      id,
      level: 2,
      kind: 'module',
      label: node.label,
      parent: parentId,
      path: node.path,
      hasChildren: childIds.length > 0 || directFiles.length > 0,
      childCount: files.length,
      childNodes: childIds.length + directFiles.length,
      metrics: {
        files: files.length,
        symbols: files.reduce((s, f) => s + (symbolsByFile.get(f) ?? 0), 0),
        crossEdges: 0,
        languages: languageSet(files, fg),
      },
      external: false,
    };
    moduleNodes.push(node0);
    moduleById.set(id, node0);
    for (const f of node.files) level2Of.set(f, id);
  };

  for (const [pkgDir, entry] of treeByPkg) {
    const parentId = singleTree ? currentId : subsystemNodeId(pkgDir as string);
    for (const f of entry.files) {
      const info = fg.files.get(f)!;
      const syms = symbolsByFile.get(f) ?? 0;
      const node: GraphNode = {
        id: fileNodeId(f),
        level: 3,
        kind: 'file',
        label: baseName(f),
        parent: '',
        path: f,
        hasChildren: syms > 0,
        childCount: 0,
        childNodes: syms,
        metrics: {
          files: 1,
          symbols: syms,
          crossEdges: info.outFiles.size + info.inFiles.size,
          languages: [info.language],
        },
        external: false,
        notes: [info.lines > 0 ? `${info.lines} 行` : ''].filter(Boolean) as string[],
      };
      fileNodes.push(node);
      fileNodeById.set(node.id, node);
    }
    emitNode(remapTree(entry.tree, singleTree ? null : pkgDir), parentId);
  }

  // 不属于任何包的零散文件 → 归到系统的（散文件）模块
  const looseFiles = looseOfPkg.get('') ?? [];
  if (looseFiles.length > 0) {
    for (const f of looseFiles) {
      const info = fg.files.get(f)!;
      const syms = symbolsByFile.get(f) ?? 0;
      const node: GraphNode = {
        id: fileNodeId(f),
        level: 3,
        kind: 'file',
        label: baseName(f),
        parent: '',
        path: f,
        hasChildren: syms > 0,
        childCount: 0,
        childNodes: syms,
        metrics: { files: 1, symbols: syms, crossEdges: info.outFiles.size + info.inFiles.size, languages: [info.language] },
        external: false,
      };
      fileNodes.push(node);
      fileNodeById.set(node.id, node);
    }
    const looseGraph = filterFiles(fg, looseFiles);
    const looseTree = buildModuleTree({ ...fg, files: looseGraph }, { ...opts, branchThreshold: 2 });
    emitNode(looseTree, singleTree ? currentId : subsystemNodeId('\u0000root'));
  }

  // 文件节点的 parent 由归属表回填（散文件桶/压链后的路径都能对上）
  for (const f of fileNodes) {
    const mid = level2Of.get(f.path ?? '');
    if (mid) f.parent = mid;
  }

  // ——— L1 子系统 ———
  const subsystemNodes: GraphNode[] = [];
  if (!singleTree) {
    for (const pkg of packages) {
      const files = treeByPkg.get(pkg.dir)?.files ?? [];
      if (files.length === 0) continue;
      const ls = languageSet(files, fg);
      subsystemNodes.push({
        id: subsystemNodeId(pkg.dir),
        level: 1,
        kind: pkg.kind === 'package' ? 'package' : 'service',
        label: pkg.name,
        parent: currentId,
        path: pkg.dir,
        hasChildren: true,
        childCount: files.length,
        childNodes: countDirectModules(moduleNodes, subsystemNodeId(pkg.dir)),
        metrics: {
          files: files.length,
          symbols: files.reduce((s, f) => s + (symbolsByFile.get(f) ?? 0), 0),
          crossEdges: 0,
          languages: ls,
        },
        external: false,
      });
    }
    if (looseFiles.length > 0) {
      subsystemNodes.push({
        id: subsystemNodeId('\u0000root'),
        level: 1,
        kind: 'package',
        label: '（仓库根）',
        parent: currentId,
        path: '',
        hasChildren: true,
        childCount: looseFiles.length,
        childNodes: countDirectModules(moduleNodes, subsystemNodeId('\u0000root')),
        metrics: {
          files: looseFiles.length,
          symbols: looseFiles.reduce((s, f) => s + (symbolsByFile.get(f) ?? 0), 0),
          crossEdges: 0,
          languages: languageSet(looseFiles, fg),
        },
        external: false,
        notes: ['未归属任何工作区包的文件'],
      });
    }
  }

  // ——— L0 系统层（含外部系统推测） ———
  const systems = buildSystemsLayer({
    fg,
    project,
    currentId,
    currentName: input.systemName ?? project.name,
    currentFiles: [...fg.files.keys()].filter((p) => fg.files.get(p)!.symbols > 0),
    currentSymbols: symbolsByFile,
    fileIdOf,
    confirmed: input.externalSystems ?? [],
    moduleOf: level2Of,
    upNodes: up.nodes.values(),
  });
  warnings.push(...systems.warnings);

  // ——— 聚合边 ———
  // 文件级依赖边：子 → 父 换算成模块级；跨父节点的边提升到父节点之间
  const fileLevelOf = new Map<string, string>();
  for (const [f, id] of fileIdOf) {
    fileLevelOf.set(f, id);
  }
  const fileEdges = aggregateEdges(fg.edges, fileLevelOf, 'internal', 'exact');

  const moduleLevelOf = new Map<string, string>();
  for (const f of fg.files.keys()) {
    const mid = level2Of.get(f);
    if (mid) moduleLevelOf.set(f, mid);
  }
  const moduleEdges = aggregateEdges(fg.edges, moduleLevelOf, 'internal', 'exact');
  // 子系统层：文件 → 子系统
  const sysLevelOf = new Map<string, string>();
  for (const f of fg.files.keys()) {
    const mid = level2Of.get(f);
    if (!mid) continue;
    const l1 = mid.startsWith('pkg:') ? mid.slice(0, mid.indexOf('/')) : subsystemNodeId('\u0000root');
    sysLevelOf.set(f, l1);
  }
  const subsystemEdges = singleTree ? [] : aggregateEdges(fg.edges, sysLevelOf, 'internal', 'exact');

  // 模块链上的结构边（父 contains 子）由前端按 parent 画，不重复入图；这里只放依赖边
  edges.push(...fileEdges, ...moduleEdges, ...subsystemEdges, ...systems.edges);

  // ——— 统计回填 ———
  const childIndex = new Map<string, string[]>();
  for (const n of [...systems.nodes, ...subsystemNodes, ...moduleNodes, ...fileNodes]) {
    if (!n.parent) continue;
    const arr = childIndex.get(n.parent) ?? [];
    arr.push(n.id);
    childIndex.set(n.parent, arr);
  }
  for (const n of [...systems.nodes, ...subsystemNodes, ...moduleNodes]) {
    if (n.isCurrent) continue;
    n.childNodes = childIndex.get(n.id)?.length ?? 0;
    n.hasChildren = n.childNodes > 0;
  }
  // crossEdges：节点参与的内部依赖边权重
  const deg = new Map<string, number>();
  for (const e of edges) {
    if (e.scope !== 'internal') continue;
    deg.set(e.source, (deg.get(e.source) ?? 0) + e.weight);
    deg.set(e.target, (deg.get(e.target) ?? 0) + e.weight);
  }
  for (const n of [...subsystemNodes, ...moduleNodes]) {
    n.metrics.crossEdges = deg.get(n.id) ?? 0;
  }
  // 系统节点指标
  const totalFiles = new Set(fg.files.keys()).size;
  for (const n of systems.nodes) {
    if (n.isCurrent) {
      n.childCount = totalFiles;
      n.metrics.files = totalFiles;
      n.childNodes = childIndex.get(n.id)?.length ?? 0;
      n.hasChildren = n.childNodes > 0;
    }
  }

  return {
    nodes: [...systems.nodes, ...subsystemNodes, ...moduleNodes, ...fileNodes],
    edges: dedupeEdges(edges),
    fileGraph: fg,
    moduleTree: [...treeByPkg.values()][0]?.tree ?? { path: '', label: '（根目录）', parent: null, files: [], children: [], totalFiles: 0, totalSymbols: 0, isLoose: false },
    systemsWarnings: systems.warnings,
    externalSystems: systems.external,
    fileNodeId: fileIdOf,
  };
}

export function subsystemNodeId(pkgDir: string): string {
  return pkgDir === '\u0000root' ? 'pkg:\u0000root' : `pkg:${pkgDir}`;
}

/** 文件属于哪个工作区包（最长前缀匹配；根目录文件不属于任何包） */
export function assignPackages(fg: FileGraph, detection: RepoDetection): Map<string, string> {
  const pkgs = detection.packages.filter((p) => p.dir !== '').sort((a, b) => b.dir.length - a.dir.length);
  const out = new Map<string, string>();
  if (pkgs.length === 0) return out;
  for (const p of fg.files.keys()) {
    for (const pkg of pkgs) {
      const prefix = pkg.dir.endsWith('/') ? pkg.dir : `${pkg.dir}/`;
      if (p.startsWith(prefix)) {
        out.set(p, pkg.dir);
        break;
      }
    }
  }
  return out;
}

function filterFiles(fg: FileGraph, keep: string[]): Map<string, (typeof fg.files) extends Map<string, infer V> ? V : never> {
  const m = new Map<string, (typeof fg.files) extends Map<string, infer V> ? V : never>();
  for (const p of keep) {
    const v = fg.files.get(p);
    if (v) m.set(p, v);
  }
  return m;
}

export function collectFiles(node: ModuleTreeNode): string[] {
  const out: string[] = [...node.files];
  for (const c of node.children) out.push(...collectFiles(c));
  return out;
}

function countSymbolsByFile(up: UpstreamGraph, fg: FileGraph): Map<string, number> {
  const m = new Map<string, number>();
  for (const n of up.nodes.values()) {
    if (n.kind === 'file' || n.kind === 'import' || n.filePath === '') continue;
    const p = n.filePath.replace(/\\/g, '/');
    if (!fg.files.has(p)) continue;
    m.set(p, (m.get(p) ?? 0) + 1);
  }
  return m;
}

function countDirectModules(nodes: GraphNode[], parentId: string): number {
  let n = 0;
  for (const x of nodes) if (x.parent === parentId) n++;
  return n;
}

function languageSet(files: string[], fg: FileGraph): string[] {
  const s = new Set<string>();
  for (const f of files) {
    const l = fg.files.get(f)?.language;
    if (l) s.add(l);
  }
  return [...s].sort();
}

function baseName(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

function dedupeEdges(edges: GraphEdge[]): GraphEdge[] {
  const seen = new Map<string, GraphEdge>();
  for (const e of edges) {
    const key = `${e.scope}|${e.source}->${e.target}|${e.kind}`;
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, e);
      continue;
    }
    prev.weight += e.weight;
    for (const [k, v] of Object.entries(e.kinds)) prev.kinds[k] = (prev.kinds[k] ?? 0) + v;
    if (!prev.label) prev.label = e.label;
  }
  return [...seen.values()];
}

export type { BuildOptions };
export const __internal = { filterFiles };
export const _unusedEvidence: Evidence[] = [];
export type { NodeKind, Level };
export type { CodeMapGraph };
