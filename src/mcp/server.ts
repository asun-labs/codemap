import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { VERSION } from '../version.js';
import { runDoctor } from '../core/doctor.js';
import { checkIndex } from '../core/check-index.js';
import { buildMap } from '../core/map.js';
import { computeUnknowns } from '../core/unknowns.js';
import { scanEdges } from '../core/boundaries.js';
import { pierceBoundary } from '../core/pierce.js';
import { tracePath } from '../core/trace.js';
import { buildFeatures, describeFeature } from '../core/features.js';
import { impactAnalysis } from '../core/impact.js';
import { searchNodes, outlineNode } from '../core/search.js';
import { resolveProject, ownDbExists } from '../util/paths.js';
import { openOwnDb } from '../db/own.js';
import { getProjection, pagePayload } from '../db/projections.js';
import { analyze, loadGraph } from '../analyze/analyze.js';
import { acquire, looksLikeGitUrl } from '../acquire/git.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

/** stdio 卫生：协议只走 stdout，一切诊断进 stderr */
function diag(msg: string): void {
  console.error(`[codemap] ${msg}`);
}

function textResult(v: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }],
  };
}

async function wrap(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return textResult(await fn());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    diag(`工具执行失败: ${msg}`);
    return { content: [{ type: 'text', text: msg }], isError: true };
  }
}

export async function startMcpServer(): Promise<void> {
  const server = new McpServer(
    { name: 'codemap', version: VERSION },
    {
      instructions:
        'CodeMap 代码地图。系统图 v3（重点）：codemap_system_analyze（路径或 git 地址→4 级系统关系图）→ ' +
        'codemap_system_graph（顶层骨架：当前系统+外部系统+协议边）→ codemap_system_node（逐级下钻到文件）。' +
        'P0–P5 深度工具：doctor / check_index / map（出图）/ unknowns（盲区）/ edges（边界）/ ' +
        'pierce（rea 穿透）/ trace（跨缝调用链）/ features（功能切片）/ describe_feature / impact（影响面）/ search / outline / get（投影取回）。' +
        'CodeMap 绝不静默安装、绝不代跑小时级索引、绝不写上游库。',
    },
  );

  server.registerTool(
    'codemap_doctor',
    {
      title: 'CodeMap Doctor',
      description:
        '依赖体检：codegraph（硬依赖）/ rea（软依赖）探测、索引新鲜度、镜像状态、覆盖评级（四态 coverage）',
      inputSchema: { path: z.string().optional().describe('工程路径，缺省为当前工作目录') },
    },
    ({ path }) => wrap(async () => runDoctor(path)),
  );

  server.registerTool(
    'codemap_check_index',
    {
      title: 'CodeMap Check Index',
      description:
        '只检查不代跑：是否已索引、pendingChanges 新鲜度、extraction 版本白名单、镜像 stale 状态，并返回指引',
      inputSchema: { path: z.string().optional().describe('工程路径，缺省为当前工作目录') },
    },
    ({ path }) => wrap(async () => checkIndex(path)),
  );

  server.registerTool(
    'codemap_map',
    {
      title: 'CodeMap Map',
      description:
        '代码地图出图：自适应聚合折叠（system/module/symbol 三级粒度，maxNodes 兜底），' +
        '支持 focus+N 跳展开与 module:<路径> 范围，输出 mermaid / dot / codemap-graph json',
      inputSchema: {
        path: z.string().optional().describe('工程路径，缺省为当前工作目录'),
        level: z.enum(['system', 'module', 'symbol']).optional().describe('聚合粒度，默认 system'),
        maxNodes: z.number().int().min(1).max(500).optional().describe('节点预算，默认 60'),
        focus: z.string().optional().describe('以某单元为中心'),
        depth: z.number().int().min(1).max(10).optional().describe('focus 展开跳数，默认 3'),
        format: z.enum(['mermaid', 'dot', 'json']).optional().describe('输出格式，默认 mermaid'),
        scope: z.string().optional().describe('project | module:<路径>'),
      },
    },
    ({ path, ...params }) => wrap(async () => buildMap(resolveProject(path), params)),
  );

  server.registerTool(
    'codemap_unknowns',
    {
      title: 'CodeMap Unknowns',
      description:
        '盲区清单：聚合 codegraph 自己没解析的引用（unresolved_refs）——按种类/目录/文件分布 + most-wanted 符号 + 范围 coverage。不暴露盲区就会默认图是完整的',
      inputSchema: {
        path: z.string().optional().describe('工程路径，缺省为当前工作目录'),
        scope: z.string().optional().describe('project | module:<路径>'),
      },
    },
    ({ path, scope }) =>
      wrap(async () => {
        const projectPath = resolveProject(path);
        if (scope && scope !== 'project') {
          if (!scope.startsWith('module:')) throw new Error(`scope 仅支持 project | module:<路径>，收到: ${scope}`);
          return computeUnknowns(projectPath, scope.slice('module:'.length));
        }
        return computeUnknowns(projectPath);
      }),
  );

  server.registerTool(
    'codemap_edges',
    {
      title: 'CodeMap Edges',
      description:
        '外部边界清单：native 插件(.node/.dll/.so/.dylib)/wasm/asar/预编译包 + HTTP 出口 + 环境变量 + DB 指示器，静态扫描只读；二进制边界标注 rea 可否穿透（穿透本身用 codemap_pierce）',
      inputSchema: { path: z.string().optional().describe('工程路径，缺省为当前工作目录') },
    },
    ({ path }) => wrap(async () => scanEdges(resolveProject(path))),
  );

  server.registerTool(
    'codemap_pierce',
    {
      title: 'CodeMap Pierce',
      description:
        '对单个边界（codemap_edges 给出的 boundary id）调 rea 穿透。rea 未安装时诚实返回 blocked + 安装指引，绝不静默安装；结果按内容哈希缓存',
      inputSchema: {
        path: z.string().optional().describe('工程路径，缺省为当前工作目录'),
        boundary: z.string().describe('边界 id（boundary:<kind>:<path>）或路径'),
      },
    },
    ({ path, boundary }) => wrap(async () => pierceBoundary(resolveProject(path), boundary)),
  );

  server.registerTool(
    'codemap_trace',
    {
      title: 'CodeMap Trace',
      description: '跨缝调用链：镜像图上有向最短路径（可选无向回退并注明），用于「从入口落到数据库/边界」的证据链',
      inputSchema: {
        path: z.string().optional().describe('工程路径，缺省为当前工作目录'),
        from: z.string().describe('起点：节点 id 或唯一符号名'),
        to: z.string().describe('终点：节点 id 或唯一符号名'),
        undirected: z.boolean().optional().describe('允许无向回退，默认允许'),
      },
    },
    ({ path, from, to, undirected }) => wrap(async () => tracePath(resolveProject(path), from, to, { undirected })),
  );

  server.registerTool(
    'codemap_features',
    {
      title: 'CodeMap Features',
      description:
        '功能切片：L4 入口（路由/IPC）→ 可达子图 → 功能卡（入口/成员/分层/coverage/盲区限制）。巨型入口降级 seed，fan-in≥3 判 shared',
      inputSchema: {
        path: z.string().optional().describe('工程路径，缺省为当前工作目录'),
        maxDepth: z.number().int().min(1).max(10).optional().describe('可达深度，默认 5'),
        maxFeatureNodes: z.number().int().min(10).max(2000).optional().describe('单功能节点上限，默认 500'),
      },
    },
    ({ path, ...opts }) => wrap(async () => buildFeatures(resolveProject(path), opts)),
  );

  server.registerTool(
    'codemap_describe_feature',
    {
      title: 'CodeMap Describe Feature',
      description: '单个功能切片的完整卡：入口证据、成员明细（符号/文件/行）、coverage 与盲区',
      inputSchema: {
        path: z.string().optional().describe('工程路径，缺省为当前工作目录'),
        feature: z.string().describe('功能名或 feature:<id>（先 codemap_features 列出）'),
      },
    },
    ({ path, feature }) => wrap(async () => describeFeature(resolveProject(path), feature)),
  );

  server.registerTool(
    'codemap_impact',
    {
      title: 'CodeMap Impact',
      description: '影响面：从目标符号反向可达（谁会受影响）+ L4 放大（受影响路由/IPC 入口）',
      inputSchema: {
        path: z.string().optional().describe('工程路径，缺省为当前工作目录'),
        symbol: z.string().describe('目标符号名或节点 id'),
        depth: z.number().int().min(1).max(20).optional().describe('反向传播深度，默认 10'),
      },
    },
    ({ path, symbol, depth }) => wrap(async () => impactAnalysis(resolveProject(path), symbol, { depth })),
  );

  server.registerTool(
    'codemap_search',
    {
      title: 'CodeMap Search',
      description: '镜像符号名检索（LIKE，top-N），用于定位节点 id 供 trace/impact/outline 使用',
      inputSchema: {
        path: z.string().optional().describe('工程路径，缺省为当前工作目录'),
        q: z.string().describe('符号名关键词'),
        limit: z.number().int().min(1).max(100).optional().describe('返回上限，默认 20'),
      },
    },
    ({ path, q, limit }) => wrap(async () => searchNodes(resolveProject(path), q, limit)),
  );

  server.registerTool(
    'codemap_outline',
    {
      title: 'CodeMap Outline',
      description: '节点大纲：符号本体 + contains 层级（父容器/子成员）',
      inputSchema: {
        path: z.string().optional().describe('工程路径，缺省为当前工作目录'),
        node: z.string().describe('节点 id 或唯一符号名'),
      },
    },
    ({ path, node }) => wrap(async () => outlineNode(resolveProject(path), node)),
  );

  server.registerTool(
    'codemap_get',
    {
      title: 'CodeMap Get',
      description: '按 handle 取回此前工具返回摘要对应的完整投影（分页）；handle TTL 1 小时',
      inputSchema: {
        path: z.string().optional().describe('工程路径，缺省为当前工作目录'),
        handle: z.string().describe('此前响应中返回的 handle'),
        offset: z.number().int().min(0).optional().describe('分页偏移（上一次响应的 nextOffset）'),
      },
    },
    ({ path, handle, offset }) =>
      wrap(async () => {
        const projectPath = resolveProject(path);
        if (!ownDbExists(projectPath)) {
          throw new Error('镜像不存在，无法解析 handle —— 先运行 codemap mirror <path>');
        }
        const db = openOwnDb(projectPath);
        try {
          const hit = getProjection(db, handle);
          if (hit === 'missing') throw new Error(`handle 不存在: ${handle}`);
          if (hit === 'expired') throw new Error(`handle 已过期: ${handle} —— 请重新请求原工具`);
          return { handle, ...pagePayload(hit.payload, offset) };
        } finally {
          try {
            db.close();
          } catch {
            /* 已关闭则忽略 */
          }
        }
      }),
  );

  server.registerTool(
    'codemap_system_analyze',
    {
      title: 'CodeMap System Analyze',
      description:
        '系统图 v3 分析：本地路径或远端 git 地址（自动克隆）→ codegraph 索引 → 4 级系统关系图' +
        '（L0 系统/L1 子系统/L2 模块/L3 文件，测试文件过滤）+ 外部系统推测 + 架构视图，写入 <root>/.codemap/graph.json',
      inputSchema: {
        path: z.string().optional().describe('工程路径或 git 地址，缺省为当前工作目录'),
        reindex: z.boolean().optional().describe('强制重建 codegraph 索引'),
        includeTests: z.boolean().optional().describe('不过滤测试文件（默认过滤）'),
        ref: z.string().optional().describe('git 分支/tag/commit'),
        force: z.boolean().optional().describe('git 目标时强制重新克隆'),
      },
    },
    ({ path, reindex, includeTests, ref, force }) =>
      wrap(async () => {
        const target = path ?? '.';
        const acq = looksLikeGitUrl(target)
          ? await acquire({ target, ref, force: force ?? false }, (l) => diag(l))
          : {
              kind: 'local' as const,
              root: resolveProject(target),
              source: target,
              cloned: false,
              notes: [] as string[],
            };
        const g = await analyze({
          root: acq.root,
          source: acq.source,
          sourceKind: acq.kind,
          reindex: reindex ?? false,
          includeTests: includeTests ?? false,
          log: (l) => diag(l),
        });
        return {
          name: g.project.name,
          root: g.project.root,
          stats: g.project.stats,
          nodes: g.nodes.length,
          edges: g.edges.length,
          externalSystems: g.nodes.filter((n) => n.external).map((n) => n.label),
          warnings: g.warnings,
          graphFile: `${acq.root}/.codemap/graph.json`,
          hint: '用 codemap_system_graph 看顶层，codemap_system_node 逐级下钻',
        };
      }),
  );

  server.registerTool(
    'codemap_system_graph',
    {
      title: 'CodeMap System Graph',
      description:
        '系统图 v3 顶层视图：项目信息、L0 系统骨架（当前系统 + 外部系统，含协议/方向/置信度）、' +
        'L1/L2 顶层子结构与架构分层。先跑 codemap_system_analyze 生成 graph.json',
      inputSchema: { path: z.string().optional().describe('工程路径，缺省为当前工作目录') },
    },
    ({ path }) =>
      wrap(async () => {
        const g = loadGraph(resolveProject(path));
        if (!g) throw new Error('没有分析结果（.codemap/graph.json 缺失）—— 先运行 codemap_system_analyze');
        const top = g.nodes.filter((n) => n.level === 0 || n.level === 1 || n.parent === null);
        return {
          project: g.project,
          warnings: g.warnings,
          systemsDraft: g.systems.draft,
          skeleton: top.map((n) => ({
            id: n.id,
            level: n.level,
            kind: n.kind,
            label: n.label,
            external: n.external,
            childCount: n.childCount,
            metrics: n.metrics,
          })),
          wires: g.edges.filter((e) => e.scope === 'system'),
          architecture: {
            strategy: g.architecture.strategy,
            layers: g.architecture.layers.map((l) => ({ name: l.name, members: l.members.length })),
          },
        };
      }),
  );

  server.registerTool(
    'codemap_system_node',
    {
      title: 'CodeMap System Node',
      description:
        '系统图 v3 节点下钻：单个节点的指标、子节点（下一层，可继续下钻到文件）、关系边' +
        '（类型/权重/协议/置信度/证据 file:line）。id 形如 sys:__current__、pkg:<dir>、mod/<路径>、file:<路径>',
      inputSchema: {
        path: z.string().optional().describe('工程路径，缺省为当前工作目录'),
        id: z.string().describe('节点 id（codemap_system_graph 返回的 id）'),
      },
    },
    ({ path, id }) =>
      wrap(async () => {
        const g = loadGraph(resolveProject(path));
        if (!g) throw new Error('没有分析结果（.codemap/graph.json 缺失）—— 先运行 codemap_system_analyze');
        const node = g.nodes.find((n) => n.id === id);
        if (!node) {
          const sample = g.nodes.filter((n) => n.level <= 1).map((n) => n.id).slice(0, 20);
          throw new Error(`节点不存在: ${id}。顶层节点有: ${sample.join(', ')}`);
        }
        const children = g.nodes
          .filter((n) => n.parent === id)
          .map((n) => ({ id: n.id, kind: n.kind, label: n.label, level: n.level, childCount: n.childCount }));
        const relations = g.edges
          .filter((e) => e.source === id || e.target === id)
          .sort((a, b) => b.weight - a.weight)
          .slice(0, 50)
          .map((e) => ({
            dir: e.source === id ? 'out' : 'in',
            other: e.source === id ? e.target : e.source,
            kind: e.kind,
            label: e.label,
            protocol: e.protocol,
            confidence: e.confidence,
            evidence: e.evidence,
          }));
        return {
          node: {
            id: node.id,
            level: node.level,
            kind: node.kind,
            label: node.label,
            path: node.path,
            external: node.external,
            metrics: node.metrics,
            notes: node.notes,
          },
          children,
          relations,
        };
      }),
  );

  await server.connect(new StdioServerTransport());
  diag(`codemap mcp v${VERSION} ready (stdio)`);
}
