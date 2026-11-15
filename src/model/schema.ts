/**
 * CodeMap 图模型（v3）—— 唯一事实来源。
 *
 * 设计要点：
 * - 层级用 `Level = 0..3` 固定四级，节点自带 `hasChildren`，前端按需展开而不是预先折叠。
 * - 边一律有方向 + 协议 + 置信度 + 证据，跨系统边与系统内边共用一套结构。
 * - 所有推断都带 `confidence`，`exact` 才能当事实用；这是本工具的铁律。
 */

/** 0 系统 / 1 子系统 / 2 模块 / 3 文件（点击文件节点出符号清单，不再有 4 级） */
export type Level = 0 | 1 | 2 | 3;

export const LEVEL_NAMES: Record<Level, string> = {
  0: '系统',
  1: '子系统',
  2: '模块',
  3: '文件',
};

/** exact = 静态可证；inferred = 模式匹配/命名推断；config = 用户配置确认 */
export type Confidence = 'exact' | 'inferred' | 'config' | 'unknown';

export interface Evidence {
  file: string;
  line: number;
  note?: string;
}

export interface GraphNode {
  /** 全局唯一 id，跨次构建稳定（同路径同层级 → 同 id） */
  id: string;
  level: Level;
  kind: NodeKind;
  label: string;
  /** 父节点 id；level 0 为 null */
  parent: string | null;
  /** 是否还有下一层可展开（文件节点也可能 false：空文件/未索引） */
  hasChildren: boolean;
  /** 仓库相对路径（posix），模块/文件/子系统节点用它定位；系统级节点为 null */
  path: string | null;
  /** 子节点里的叶子数量（模块/系统显示用） */
  childCount: number;
  /** 下一层直接子节点个数（前端 +N 显示用；文件节点为符号数） */
  childNodes: number;
  /** 聚合指标 */
  metrics: NodeMetrics;
  /** 只有 level 0 的系统可能为 true：没有源码，不可下钻 */
  external: boolean;
  /** 该节点是否对应本次分析的当前系统 */
  isCurrent?: boolean;
  /** 被并入/降级的说明（门面检测、超限合并等） */
  notes?: string[];
}

export type NodeKind =
  | 'system'
  | 'service'
  | 'package'
  | 'module'
  | 'file'
  | 'external-system'
  | 'datastore'
  | 'gateway';

export interface NodeMetrics {
  files: number;
  symbols: number;
  /** 参与跨文件依赖的边数（calls/imports/references 去重后） */
  crossEdges: number;
  languages: string[];
}

/** 边的作用域：层内（同级之间）或跨层（父子之间） */
export type EdgeScope = 'internal' | 'system';

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  scope: EdgeScope;
  /** wire = 进程/网络边界（跨系统）；structure = 结构归属；dependency = 代码依赖 */
  kind: EdgeKind;
  /** 线业务协议：http / grpc / mq / db / fs / ipc / sdk / tcp / unknown */
  protocol: string;
  /** 线上文字（可为空）：例如 "POST /api/login"、"MySQL" */
  label: string;
  /** 该聚合边由多少条原始边合成 */
  weight: number;
  /** calls / imports / references / contains 的分布 */
  kinds: Record<string, number>;
  confidence: Confidence;
  evidence: Evidence[];
}

export type EdgeKind = 'wire' | 'structure' | 'dependency';

/** 被分析系统的元信息 */
export interface ProjectInfo {
  /** 展示名（默认取仓库名，可被 systems.yaml 覆盖） */
  name: string;
  /** 工作区绝对路径 */
  root: string;
  /** 来源：本地路径或 git url */
  source: string;
  sourceKind: 'local' | 'git';
  /** git 信息（本地非 git 仓库则缺席） */
  git?: {
    branch: string | null;
    commit: string | null;
    remote: string | null;
    dirty?: boolean;
  };
  /** 语言分布（按文件数降序） */
  languages: Array<{ language: string; files: number }>;
  analyzedAt: string;
  stats: {
    files: number;
    symbols: number;
    edges: number;
    unresolvedRefs: number;
    /** 被过滤掉的测试文件数 */
    testsFiltered: number;
    /** 平均解析率，0..1；null 表示无数据 */
    coverage: number | null;
  };
}

/** 架构页签：分层架构图（纵向分层 + 每层成员） */
export interface ArchitectureLayer {
  id: string;
  name: string;
  /** 该层主要承载的目录 */
  paths: string[];
  members: Array<{ id: string; label: string; files: number; symbols: number }>;
  /** 上层 → 下层 的依赖次数 */
  edgesToBelow: number;
}

export interface ArchitectureView {
  /** 分层策略说明（哪条规则命中的） */
  strategy: string;
  layers: ArchitectureLayer[];
  /** 无法归层的部分 */
  unassigned: Array<{ label: string; files: number }>;
  /** 入口/出口要点 */
  entrypoints: Array<{ label: string; file: string; line?: number; protocol?: string }>;
  notes: string[];
  /** 后端是否给出 Mermaid 兜底（无 JS 环境时可看） */
  mermaid: string;
}

export interface SystemsFileModel {
  /** 系统清单（来自 systems.yaml，用户确认） */
  systems: SystemSpec[];
  edges: SystemSpecEdge[];
  /** yaml 路径，便于 UI 提示「去改这里」 */
  configPath: string | null;
  /** true = 本次是自动生成的建议稿，尚未人工确认 */
  draft: boolean;
}

export interface SystemSpec {
  id: string;
  name: string;
  kind: 'current' | 'external';
  description?: string;
  owner?: string;
  tags?: string[];
}

export interface SystemSpecEdge {
  source: string;
  target: string;
  protocol: string;
  label?: string;
  /** 方向语义：双向 = two-way */
  direction?: 'one-way' | 'two-way';
}

/** 落盘的完整图（web 与 MCP 都只读它） */
export interface CodeMapGraph {
  schema: 'codemap-graph/3';
  project: ProjectInfo;
  nodes: GraphNode[];
  edges: GraphEdge[];
  systems: SystemsFileModel;
  architecture: ArchitectureView;
  warnings: string[];
}
