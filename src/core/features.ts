import { openOwnDb } from '../db/own.js';
import { loadGraph, type LoadedGraph, type GraphNode } from './graph-load.js';
import { SYMBOL_KINDS, toPosix } from './map-fold.js';
import { buildL4Index, type L4Node } from './adapters.js';
import { computeFilesCoverage, type Coverage } from './coverage.js';
import { resolveProject } from '../util/paths.js';

/** 切片图边种类（v2 §6.1 定稿：contains 不计跳数，也不参与可达） */
const SLICE_KINDS = new Set(['calls', 'instantiates', 'extends', 'implements']);
const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_MAX_FEATURE_NODES = 500;
const DEFAULT_SHARED_FAN_IN = 3;
const GIANT_RATIO = 0.4;

export interface SliceEntry {
  id: string;
  label: string;
  kind: string;
  filePath: string;
  line: number;
  targetNodeId: string | null;
  confidence: string;
  evidence: string;
}

export interface RawSlice {
  entries: SliceEntry[];
  /** node → 距入口的最小跳数 */
  members: Map<string, number>;
  truncated: boolean;
}

export interface SliceOutcome {
  slices: RawSlice[];
  giantSeeds: Array<{ entry: SliceEntry; reachable: number }>;
  shared: Array<{ id: string; name: string; usedBy: number }>;
  unassigned: number;
  notes: string[];
}

export interface SliceOptions {
  maxDepth?: number;
  maxFeatureNodes?: number;
  sharedFanIn?: number;
  totalSymbols?: number;
  /** 巨型入口判定比例（默认 0.4；小工程测试可调高） */
  giantRatio?: number;
}

/**
 * 功能切片核心（v2 §6.1 定稿规则）：
 * 入口 BFS（depth 5）→ 巨型入口 >40% 降级 seed → fan-in ≥3 判 shared（入口豁免）→
 * 争用按最短跳归属 → 包含度 >0.7 合并 → maxFeatureNodes 500 截断。
 */
export function sliceGraph(g: LoadedGraph, entries: SliceEntry[], opts: SliceOptions = {}): SliceOutcome {
  const notes: string[] = [];
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = opts.maxFeatureNodes ?? DEFAULT_MAX_FEATURE_NODES;
  const fanIn = opts.sharedFanIn ?? DEFAULT_SHARED_FAN_IN;
  const giantRatio = opts.giantRatio ?? GIANT_RATIO;

  const isSliceNode = (n: GraphNode): boolean => SYMBOL_KINDS.has(n.kind) || ['route', 'ipc', 'bridge', 'table'].includes(n.kind);
  let totalSymbols = opts.totalSymbols;
  if (totalSymbols == null) {
    totalSymbols = 0;
    for (const n of g.nodes.values()) if (isSliceNode(n)) totalSymbols++;
  }

  // 正向邻接（切片边）
  const adj = new Map<string, string[]>();
  for (const e of g.edges) {
    if (!SLICE_KINDS.has(e.kind)) continue;
    const arr = adj.get(e.source) ?? [];
    arr.push(e.target);
    adj.set(e.source, arr);
  }

  // 每个 entry 的可达集（带距离）
  const reach = new Map<number, Map<string, number>>(); // entryIdx → node → dist
  const emptyEntries: SliceEntry[] = [];
  entries.forEach((entry, idx) => {
    const start = entry.targetNodeId;
    if (!start || !g.nodes.has(start)) {
      emptyEntries.push(entry);
      reach.set(idx, new Map());
      return;
    }
    const dist = new Map<string, number>([[start, 0]]);
    let frontier = [start];
    for (let d = 1; d <= maxDepth && frontier.length > 0; d++) {
      const next: string[] = [];
      for (const cur of frontier) {
        for (const nb of adj.get(cur) ?? []) {
          if (!dist.has(nb)) {
            dist.set(nb, d);
            next.push(nb);
          }
        }
      }
      frontier = next;
    }
    reach.set(idx, dist);
  });
  if (emptyEntries.length > 0) {
    notes.push(`${emptyEntries.length} 个入口没有可缝合的符号，跳过其切片（先跑镜像 / 检查缝合）`);
  }

  // 巨型入口降级 seed
  const giantLimit = giantRatio * Math.max(1, totalSymbols);
  const giantIdx = new Set<number>();
  for (const [idx, dist] of reach) {
    if (dist.size > giantLimit) {
      giantIdx.add(idx);
      notes.push(`入口 ${entries[idx]?.label} 可达 ${dist.size} 节点（>40%），降级为 seed 不单独成片`);
    }
  }

  // 归属
  const claims = new Map<string, Array<{ idx: number; dist: number }>>();
  for (const [idx, dist] of reach) {
    if (giantIdx.has(idx)) continue;
    for (const [node, d] of dist) {
      const arr = claims.get(node) ?? [];
      arr.push({ idx, dist: d });
      claims.set(node, arr);
    }
  }
  // 入口目标节点始终归属到指向它的所有入口（豁免只作用于 shared 判定）
  const targetOwners = new Map<string, number[]>();
  entries.forEach((e, idx) => {
    if (e.targetNodeId && !giantIdx.has(idx) && reach.get(idx)?.has(e.targetNodeId)) {
      const arr = targetOwners.get(e.targetNodeId) ?? [];
      arr.push(idx);
      targetOwners.set(e.targetNodeId, arr);
    }
  });

  const shared: Array<{ id: string; name: string; usedBy: number }> = [];
  const memberOf = new Map<number, Map<string, number>>(); // entryIdx → members
  entries.forEach((_, idx) => {
    if (!giantIdx.has(idx)) memberOf.set(idx, new Map());
  });

  for (const [node, cs] of claims) {
    const owners = targetOwners.get(node);
    if (owners) {
      for (const idx of owners) (memberOf.get(idx) as Map<string, number>).set(node, 0);
      continue;
    }
    if (cs.length >= fanIn) {
      const n = g.nodes.get(node);
      shared.push({ id: node, name: n?.name ?? node, usedBy: cs.length });
      continue;
    }
    if (cs.length === 1) {
      const c = cs[0] as { idx: number; dist: number };
      (memberOf.get(c.idx) as Map<string, number>).set(node, c.dist);
    } else {
      // 争用（2 个）：按最短跳，平手按 entry 顺序
      const best = [...cs].sort((a, b) => a.dist - b.dist || a.idx - b.idx)[0] as { idx: number; dist: number };
      (memberOf.get(best.idx) as Map<string, number>).set(node, best.dist);
    }
  }

  // 组装 slices（空切片丢弃并记 note）
  const emptyCount = [...memberOf.entries()].filter(([idx, m]) => !giantIdx.has(idx) && m.size === 0).length;
  if (emptyCount > 0) notes.push(`${emptyCount} 个入口的可达集为空，未成片`);
  let slices: RawSlice[] = [...memberOf.entries()]
    .filter(([, members]) => members.size > 0)
    .map(([idx, members]) => ({
      entries: [entries[idx] as SliceEntry],
      members,
      truncated: false,
    }));

  // 包含度合并：|A∩B|/min(|A|,|B|) > 0.7 → 小并进大
  let merged = true;
  while (merged && slices.length > 1) {
    merged = false;
    outer: for (let i = 0; i < slices.length; i++) {
      for (let j = i + 1; j < slices.length; j++) {
        const a = slices[i] as RawSlice;
        const b = slices[j] as RawSlice;
        const inter = [...a.members.keys()].filter((k) => b.members.has(k)).length;
        const min = Math.min(a.members.size, b.members.size);
        if (min > 0 && inter / min > 0.7) {
          const [big, small] = a.members.size >= b.members.size ? [a, b] : [b, a];
          for (const [node, d] of small.members) {
            const cur = big.members.get(node);
            if (cur == null || d < cur) big.members.set(node, d);
          }
          big.entries.push(...small.entries);
          slices.splice(slices.indexOf(small), 1);
          merged = true;
          notes.push(`切片 ${small.entries[0]?.label} 与 ${big.entries[0]?.label} 包含度超 0.7，已合并`);
          break outer;
        }
      }
    }
  }

  // maxFeatureNodes 截断（保留离入口最近的）
  for (const s of slices) {
    if (s.members.size > maxNodes) {
      const keep = [...s.members.entries()].sort((a, b) => a[1] - b[1]).slice(0, maxNodes);
      s.members = new Map(keep);
      s.truncated = true;
    }
  }

  slices.sort((a, b) => b.members.size - a.members.size);
  return { slices, giantSeeds: [], shared, unassigned: 0, notes };
}

// giantSeeds 的实际数据在 sliceGraph 内已产生，这里补全（避免闭包复杂化）
export function computeGiantSeeds(g: LoadedGraph, entries: SliceEntry[], opts: SliceOptions = {}): Array<{ entry: SliceEntry; reachable: number }> {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const adj = buildSliceAdjacency(g);
  const giantRatio = opts.giantRatio ?? GIANT_RATIO;
  const isSliceNode = (n: GraphNode): boolean => SYMBOL_KINDS.has(n.kind) || ['route', 'ipc', 'bridge', 'table'].includes(n.kind);
  let total = opts.totalSymbols;
  if (total == null) {
    total = 0;
    for (const n of g.nodes.values()) if (isSliceNode(n)) total++;
  }
  const out: Array<{ entry: SliceEntry; reachable: number }> = [];
  for (const entry of entries) {
    if (!entry.targetNodeId || !g.nodes.has(entry.targetNodeId)) continue;
    const seen = new Set<string>([entry.targetNodeId]);
    let frontier = [entry.targetNodeId];
    for (let d = 1; d <= maxDepth && frontier.length > 0; d++) {
      const next: string[] = [];
      for (const cur of frontier) {
        for (const nb of adj.get(cur) ?? []) {
          if (!seen.has(nb)) {
            seen.add(nb);
            next.push(nb);
          }
        }
      }
      frontier = next;
    }
    if (seen.size > giantRatio * Math.max(1, total)) out.push({ entry, reachable: seen.size });
  }
  return out;
}

function buildSliceAdjacency(g: LoadedGraph): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const e of g.edges) {
    if (!SLICE_KINDS.has(e.kind)) continue;
    let arr = adj.get(e.source);
    if (!arr) {
      arr = [];
      adj.set(e.source, arr);
    }
    arr.push(e.target);
  }
  return adj;
}

export interface FeatureCard {
  id: string;
  name: string;
  entrypoints: Array<{ id: string; label: string; kind: string; filePath: string; line: number; confidence: string }>;
  nodes: number;
  files: string[];
  layers: Record<string, number>;
  coverage: Coverage;
  truncated: boolean;
  limitations: string[];
}

export interface FeaturesReport {
  projectPath: string;
  entriesConsidered: number;
  giantSeeds: Array<{ label: string; reachable: number }>;
  shared: Array<{ id: string; name: string; usedBy: number }>;
  features: FeatureCard[];
  notes: string[];
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'feature';
}

/** P5 features：L4 入口 → 切片 → 功能卡（含 coverage 与 limitations） */
export function buildFeatures(projectPathInput: string, opts: SliceOptions = {}): FeaturesReport {
  const projectPath = resolveProject(projectPathInput);
  const db = openOwnDb(projectPath);
  try {
    const g = loadGraph(db);
    const l4 = buildL4Index(projectPath, g);
    const entries: SliceEntry[] = l4.nodes
      .filter((n) => n.kind === 'route' || n.kind === 'ipc')
      .map((n: L4Node) => ({
        id: n.id,
        label: n.label,
        kind: n.kind,
        filePath: n.filePath,
        line: n.line,
        targetNodeId: n.targetNodeId,
        confidence: n.confidence,
        evidence: n.evidence,
      }));
    if (entries.length === 0) {
      return {
        projectPath,
        entriesConsidered: 0,
        giantSeeds: [],
        shared: [],
        features: [],
        notes: ['没有 L4 入口（路由/IPC）——先确认适配器能识别本工程的框架，或等待更多适配器'],
      };
    }

    const outcome = sliceGraph(g, entries, opts);
    const giantSeeds = computeGiantSeeds(g, entries, opts);
    const cards: FeatureCard[] = outcome.slices.map((s) => {
      const files = new Set<string>();
      const layers: Record<string, number> = {};
      for (const nodeId of s.members.keys()) {
        const n = g.nodes.get(nodeId);
        if (!n) continue;
        layers[n.kind] = (layers[n.kind] ?? 0) + 1;
        if (n.filePath) files.add(toPosix(n.filePath));
      }
      const fileList = [...files].sort();
      const coverage = computeFilesCoverage(db, fileList);
      const limitations: string[] = [];
      if (s.truncated) limitations.push(`节点数超出上限 ${opts.maxFeatureNodes ?? DEFAULT_MAX_FEATURE_NODES}，已按跳数截断`);
      // v2：卡内文件集 unresolved 按 reference_kind 聚合
      const unres = aggregateUnresolved(db, fileList);
      if (unres.total > 0) {
        limitations.push(
          `盲区: ${unres.total} 个未解析引用（${unres.topKinds.map((k) => `${k.kind}×${k.count}`).join(' ')}）`,
        );
      }
      const name = s.entries.map((e) => e.label).join(' + ');
      return {
        id: `feature:${slug(s.entries[0]?.label ?? name)}`,
        name,
        entrypoints: s.entries.map((e) => ({
          id: e.id,
          label: e.label,
          kind: e.kind,
          filePath: e.filePath,
          line: e.line,
          confidence: e.confidence,
        })),
        nodes: s.members.size,
        files: fileList,
        layers,
        coverage,
        truncated: s.truncated,
        limitations,
      };
    });
    // 同 id 合并（slug 冲突）
    const byId = new Map<string, FeatureCard>();
    for (const c of cards) {
      const prev = byId.get(c.id);
      if (!prev) {
        byId.set(c.id, c);
      } else {
        prev.entrypoints.push(...c.entrypoints);
        prev.nodes = Math.max(prev.nodes, c.nodes);
        prev.files = [...new Set([...prev.files, ...c.files])].sort();
        for (const [k, v] of Object.entries(c.layers)) prev.layers[k] = (prev.layers[k] ?? 0) + v;
      }
    }

    return {
      projectPath,
      entriesConsidered: entries.length,
      giantSeeds: giantSeeds.map((gs) => ({ label: gs.entry.label, reachable: gs.reachable })),
      shared: outcome.shared,
      features: [...byId.values()],
      notes: outcome.notes,
    };
  } finally {
    try {
      db.close();
    } catch {
      /* 已关闭则忽略 */
    }
  }
}

function aggregateUnresolved(db: ReturnType<typeof openOwnDb>, files: string[]): { total: number; topKinds: Array<{ kind: string; count: number }> } {
  if (files.length === 0) return { total: 0, topKinds: [] };
  const placeholders = files.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT reference_kind AS kind, COUNT(*) AS n FROM unresolved_refs WHERE file_path IN (${placeholders}) GROUP BY reference_kind ORDER BY n DESC LIMIT 5`)
    .all(...files) as Array<{ kind: string; n: number }>;
  const total = Number(
    (db.prepare(`SELECT COUNT(*) AS n FROM unresolved_refs WHERE file_path IN (${placeholders})`).get(...files) as { n: number }).n,
  );
  return { total, topKinds: rows.map((r) => ({ kind: r.kind, count: Number(r.n) })) };
}

/** describe_feature：单个功能的完整卡 + 成员明细 + 入口证据 */
export function describeFeature(projectPathInput: string, featureRef: string, opts: SliceOptions = {}): (FeatureCard & { members: Array<{ id: string; name: string; kind: string; file: string | null; line: number | null }>; evidence: string[] }) | null {
  const projectPath = resolveProject(projectPathInput);
  const report = buildFeatures(projectPath, opts);
  const ref = featureRef.toLowerCase();
  const card = report.features.find((f) => f.id.toLowerCase() === ref || f.name.toLowerCase() === ref) ??
    report.features.find((f) => f.name.toLowerCase().includes(ref) || f.id.toLowerCase().includes(`feature:${ref}`));
  if (!card) {
    const names = report.features.map((f) => f.name).slice(0, 10).join(', ');
    throw new Error(`feature 未找到: ${featureRef}（可用: ${names || '无'}）`);
  }
  const db = openOwnDb(projectPath);
  try {
    const g = loadGraph(db);
    const l4 = buildL4Index(projectPath, g);
    const members: Array<{ id: string; name: string; kind: string; file: string | null; line: number | null }> = [];
    const seen = new Set<string>();
    const adj = buildSliceAdjacency(g);
    for (const ep of card.entrypoints) {
      const l4Node = l4.nodes.find((n) => n.id === ep.id);
      const start = l4Node?.targetNodeId;
      if (!start || !g.nodes.has(start)) continue;
      const dist = new Map<string, number>([[start, 0]]);
      let frontier = [start];
      for (let d = 1; d <= DEFAULT_MAX_DEPTH && frontier.length > 0; d++) {
        const next: string[] = [];
        for (const cur of frontier) {
          for (const nb of adj.get(cur) ?? []) {
            if (!dist.has(nb)) {
              dist.set(nb, d);
              next.push(nb);
            }
          }
        }
        frontier = next;
      }
      for (const nodeId of dist.keys()) {
        if (seen.has(nodeId)) continue;
        seen.add(nodeId);
        const n = g.nodes.get(nodeId);
        members.push({ id: nodeId, name: n?.name ?? nodeId, kind: n?.kind ?? '?', file: n?.filePath ?? null, line: n?.startLine ?? null });
      }
    }
    members.sort((a, b) => (a.file ?? '').localeCompare(b.file ?? ''));
    const evidence = card.entrypoints.map((e) => `${e.label} @ ${e.filePath}:${e.line} (${e.confidence})`);
    return { ...card, members: members.slice(0, 200), evidence };
  } finally {
    try {
      db.close();
    } catch {
      /* 已关闭则忽略 */
    }
  }
}
