import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildLayeredGraph, moduleNodeId, systemNodeId } from './layered-graph.js';
import type { ArchitectureView, CodeMapGraph, ProjectInfo } from '../model/schema.js';
import { loadUpstream } from '../codegraph/reader.js';
import { codegraphDbPath, ensureIndex } from '../codegraph/run.js';
import { detectRepo } from './detect-repo.js';
import { loadSystems, renderSystemsYaml, toExternalSys, toSystemsFileModel, writeSystems } from './systems-file.js';
import { readGitInfo } from '../acquire/git.js';
import { buildArchitecture } from './architecture.js';

export interface AnalyzeOptions {
  /** 仓库根目录（已本地化/已克隆） */
  root: string;
  /** 原始输入（本地路径或 git url），写进 project.source */
  source: string;
  sourceKind: 'local' | 'git';
  /** 强制重建 codegraph 索引 */
  reindex?: boolean;
  includeTests?: boolean;
  /** 日志输出 */
  log?: (line: string) => void;
  /** 不写 .codemap/systems.yaml（CI/只读场景） */
  noWriteSystems?: boolean;
}

export const CODEMAP_DIR = '.codemap';
export const GRAPH_FILE = 'graph.json';

export function codemapDir(root: string): string {
  return path.join(root, CODEMAP_DIR);
}

export function graphFilePath(root: string): string {
  return path.join(codemapDir(root), GRAPH_FILE);
}

/** 一次完整分析：索引 → 读库 → 分层 → 系统层 → 架构 → 落盘 */
export async function analyze(opts: AnalyzeOptions): Promise<CodeMapGraph> {
  const log = opts.log ?? (() => {});
  const started = Date.now();

  log('检查 codegraph 索引…');
  const idx = await ensureIndex(opts.root, { force: opts.reindex === true, onOutput: (l) => log(l) });
  if (!idx.ok) {
    throw new Error(idx.message);
  }
  if (!idx.built) log(idx.message);

  const dbFile = codegraphDbPath(opts.root);
  if (!fs.existsSync(dbFile)) throw new Error(`索引文件缺失: ${dbFile}`);
  log('读取索引数据…');
  const up = loadUpstream(dbFile);

  const detection = detectRepo(opts.root);
  const git = await readGitInfo(opts.root);
  const systemsFile = loadSystems(opts.root);

  const project: ProjectInfo = {
    name: detection.rootName,
    root: opts.root,
    source: opts.source,
    sourceKind: opts.sourceKind,
    git: git
      ? { branch: git.branch, commit: git.commit, remote: git.remote, dirty: git.dirty }
      : undefined,
    languages: [],
    analyzedAt: new Date().toISOString(),
    stats: { files: 0, symbols: 0, edges: 0, unresolvedRefs: 0, testsFiltered: 0, coverage: null },
  };

  log('构建分层骨架…');
  const built = buildLayeredGraph({
    up,
    detection,
    project,
    options: { includeTests: opts.includeTests === true },
    externalSystems: systemsFile ? toExternalSys(systemsFile.parsed) : undefined,
    systemName: systemsFile?.parsed.current?.name ?? detection.rootName,
  });

  const fg = built.fileGraph;
  const symTotal = fg.stats.symbols;
  const resolved = fg.stats.resolvedEdges + fg.stats.unresolvedRefs;
  project.stats = {
    files: fg.stats.keptFiles,
    symbols: symTotal,
    edges: built.edges.length,
    unresolvedRefs: fg.stats.unresolvedRefs,
    testsFiltered: fg.stats.testsFiltered,
    coverage: resolved > 0 ? Math.max(0, 1 - fg.stats.unresolvedRefs / resolved) : null,
  };
  project.languages = languageStats(built.nodes);

  // 没有 systems.yaml 时写出建议稿，提示用户核对
  if (!systemsFile && opts.noWriteSystems !== true) {
    const content = renderSystemsYaml({
      projectName: detection.rootName,
      projectRoot: opts.root,
      detected: built.externalSystems,
      currentId: 'current',
    });
    const w = writeSystems(opts.root, content, false);
    if (w.written) log(`已生成系统关系建议稿 ${CODEMAP_DIR}/systems.yaml（请核对后把 draft 改为 false）`);
  }

  const systemsModel = systemsFile
    ? toSystemsFileModel(systemsFile.parsed, systemsFile.configPath, systemsFile.draft)
    : toSystemsFileModel({ systems: [], edges: [] }, `${CODEMAP_DIR}/systems.yaml`, true);

  log('生成架构视图…');
  const architecture: ArchitectureView = buildArchitecture({
    nodes: built.nodes,
    edges: built.edges,
    detection,
    root: opts.root,
    currentId: systemNodeId('__current__'),
  });

  const graph: CodeMapGraph = {
    schema: 'codemap-graph/3',
    project,
    nodes: built.nodes,
    edges: built.edges,
    systems: systemsModel,
    architecture,
    warnings: built.systemsWarnings,
  };

  fs.mkdirSync(codemapDir(opts.root), { recursive: true });
  fs.writeFileSync(graphFilePath(opts.root), JSON.stringify(graph), 'utf8');
  log(`完成：${graph.nodes.length} 节点 / ${graph.edges.length} 边 / ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return graph;
}

function languageStats(nodes: CodeMapGraph['nodes']): Array<{ language: string; files: number }> {
  const m = new Map<string, number>();
  for (const n of nodes) {
    if (n.kind !== 'file') continue;
    for (const l of n.metrics.languages) m.set(l, (m.get(l) ?? 0) + 1);
  }
  return [...m.entries()].map(([language, files]) => ({ language, files })).sort((a, b) => b.files - a.files);
}

/** 读回已落盘的图（web / mcp 共用） */
export function loadGraph(root: string): CodeMapGraph | null {
  const fp = graphFilePath(root);
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8')) as CodeMapGraph;
  } catch {
    return null;
  }
}

export { moduleNodeId, systemNodeId };
