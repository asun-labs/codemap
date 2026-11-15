import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ArchitectureLayer, ArchitectureView, GraphEdge, GraphNode } from '../model/schema.js';
import type { RepoDetection } from './detect-repo.js';

/**
 * 架构页签：横向分层（rather than 目录树）。
 * 规则：按目录名/文件名的强信号归类到「表现层 / 接口层 / 业务层 / 数据层 / 基础设施」，
 * 归不进去的进 unassigned。这是一张给人看的速览图，不追求精确。
 */

const LAYER_RULES: Array<{ id: string; name: string; re: RegExp }> = [
  {
    id: 'presentation',
    name: '表现层',
    re: /(^|\/)(components?|pages?|views?|ui|layouts?|screens?|frontend|web|public|assets|styles?|css)(\/|$)|\.(tsx|jsx|vue|svelte|css|scss|less|html)$/i,
  },
  {
    id: 'interface',
    name: '接口层',
    re: /(^|\/)(api|routes?|routers?|controllers?|handlers?|endpoints?|resolvers?|graphql|grpc|rpc|middlewares?|server|http)(\/|$)/i,
  },
  {
    id: 'application',
    name: '应用/业务层',
    re: /(^|\/)(services?|usecases?|use-cases|domain|core|logic|features?|modules?|business|commands?|queries|workflows?|jobs?|tasks?|agents?)(\/|$)/i,
  },
  {
    id: 'data',
    name: '数据层',
    re: /(^|\/)(data|db|database|repos?|repositories|models?|entities|schemas?|migrations?|dao|store|stores|persistence|orm|prisma|sql)(\/|$)/i,
  },
  {
    id: 'infrastructure',
    name: '基础设施',
    re: /(^|\/)(config|configs|infra|infrastructure|scripts?|build|deploy|docker|ci|\.github|util|utils|lib|libs|shared|common|helpers?|adapters?|integrations?|sdk|types?|typings)(\/|$)/i,
  },
];

export interface ArchitectureInput {
  nodes: GraphNode[];
  edges: GraphEdge[];
  detection: RepoDetection;
  root: string;
  currentId: string;
}

export function buildArchitecture(input: ArchitectureInput): ArchitectureView {
  const files = input.nodes.filter((n) => n.kind === 'file');
  const layerOf = new Map<string, string>();

  for (const f of files) {
    const p = f.path ?? '';
    const layer = LAYER_RULES.find((r) => r.re.test(p));
    if (layer) layerOf.set(p, layer.id);
  }

  const layers: ArchitectureLayer[] = [];
  const layerIdSet = new Set<string>();
  for (const rule of LAYER_RULES) {
    const members = files.filter((f) => layerOf.get(f.path ?? '') === rule.id);
    if (members.length === 0) continue;
    layerIdSet.add(rule.id);
    const dirs = new Map<string, number>();
    for (const m of members) {
      const d = topDir(m.path ?? '');
      dirs.set(d, (dirs.get(d) ?? 0) + 1);
    }
    layers.push({
      id: rule.id,
      name: rule.name,
      paths: [...dirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([d]) => d),
      members: members
        .sort((a, b) => (b.metrics.symbols ?? 0) - (a.metrics.symbols ?? 0))
        .slice(0, 40)
        .map((m) => ({ id: m.id, label: m.path ?? m.label, files: 1, symbols: m.metrics.symbols })),
      edgesToBelow: 0,
    });
  }

  // 层间依赖：文件级边提到层
  const fileLayer = new Map<string, string>();
  for (const [p, l] of layerOf) fileLayer.set(`file:${p}`, l);
  const between = new Map<string, number>();
  for (const e of input.edges) {
    if (e.scope !== 'internal') continue;
    const a = fileLayer.get(e.source);
    const b = fileLayer.get(e.target);
    if (!a || !b || a === b) continue;
    between.set(`${a}->${b}`, (between.get(`${a}->${b}`) ?? 0) + e.weight);
  }
  for (const l of layers) {
    let below = 0;
    for (const [k, v] of between) {
      const [s] = k.split('->');
      if (s === l.id) below += v;
    }
    l.edgesToBelow = below;
  }

  const unassigned = files
    .filter((f) => !layerIdSet.has(layerOf.get(f.path ?? '') ?? ''))
    .map((f) => ({ label: f.path ?? f.label, files: 1 }))
    .slice(0, 50);

  const entrypoints = findEntrypoints(input);

  const notes: string[] = [];
  if (input.detection.monorepo) {
    notes.push(`monorepo：${input.detection.packages.length} 个工作区包（${input.detection.packages.map((p) => p.name).slice(0, 5).join(', ')}${input.detection.packages.length > 5 ? ' …' : ''}）`);
  }
  notes.push(`分层依据：目录名与文件类型规则匹配（${layers.length} 层，${files.length - unassigned.length}/${files.length} 个文件归层）`);
  if (unassigned.length > 0) notes.push(`${files.length - layerIdSet.size >= 0 ? unassigned.length : 0} 个文件未归层，见 unassigned`);

  return {
    strategy: 'directory-signal',
    layers,
    unassigned,
    entrypoints,
    notes,
    mermaid: toMermaid(layers, between),
  };
}

function findEntrypoints(input: ArchitectureInput): ArchitectureView['entrypoints'] {
  const out: ArchitectureView['entrypoints'] = [];
  const byLabel = (re: RegExp) =>
    input.nodes.filter((n) => n.kind === 'file' && re.test(n.path ?? '')).slice(0, 6);

  for (const n of byLabel(/(^|\/)(main|index|app|server|cli|bootstrap|entry)\.[cm]?[jt]sx?$/i)) {
    out.push({ label: '程序入口', file: n.path ?? '' });
  }
  for (const n of byLabel(/(^|\/)(routes?|router|urls|api)\.[cm]?[jt]s$/i)) {
    out.push({ label: '路由', file: n.path ?? '', protocol: 'http' });
  }
  for (const n of byLabel(/docker-compose[\w.-]*\.ya?ml$|Dockerfile$/i)) {
    out.push({ label: '部署', file: n.path ?? '', protocol: 'docker' });
  }
  // 跨系统边 → 出入口
  for (const n of input.nodes) {
    if (n.level !== 0 || !n.external) continue;
    out.push({ label: `外部：${n.label}`, file: '', protocol: 'wire' });
  }
  return out;
}

function topDir(p: string): string {
  const i = p.indexOf('/');
  return i < 0 ? '.' : p.slice(0, i);
}

function toMermaid(layers: ArchitectureLayer[], between: Map<string, number>): string {
  const L: string[] = ['flowchart TB'];
  for (const l of layers) {
    L.push(`  subgraph ${l.id}["${l.name} (${l.members.length})"]`);
    L.push('    direction LR');
    for (const p of l.paths.slice(0, 4)) {
      L.push(`    ${sanitize(l.id + '_' + p)}["${p}"]`);
    }
    L.push('  end');
  }
  const edges = [...between.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24);
  for (const [k, v] of edges) {
    const [s, t] = k.split('->');
    L.push(`  ${s} -->|${v}| ${t}`);
  }
  return L.join('\n');
}

function sanitize(s: string): string {
  return s.replace(/[^\w]/g, '_');
}

export const __test = { LAYER_RULES, topDir };
export type { fs };
