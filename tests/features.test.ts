import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildMirror } from '../src/db/mirror.js';
import {
  sliceGraph,
  computeGiantSeeds,
  buildFeatures,
  describeFeature,
  type SliceEntry,
} from '../src/core/features.js';
import { impactAnalysis } from '../src/core/impact.js';
import { searchNodes, outlineNode } from '../src/core/search.js';
import { loadGraph, type LoadedGraph, type GraphNode } from '../src/core/graph-load.js';
import { openOwnDb } from '../src/db/own.js';
import { createFixtureProject, fakeStatus } from './helpers/fixture.js';

async function withAdaptersMirror(): Promise<string> {
  const dir = createFixtureProject({ adapters: true });
  await buildMirror(dir, { status: fakeStatus(dir) });
  return dir;
}

function entry(id: string, target: string | null, label = id): SliceEntry {
  return { id, label, kind: 'route', filePath: 'src/x.ts', line: 1, targetNodeId: target, confidence: 'partial', evidence: '' };
}

function graphOf(pairs: Array<[string, string]>, symbols: string[]): LoadedGraph {
  const nodes = new Map<string, GraphNode>();
  for (const s of symbols) {
    nodes.set(s, { id: s, kind: 'function', name: s, qualifiedName: s, filePath: `${s}.ts`, language: 'ts', startLine: 1, endLine: 2 });
  }
  return { nodes, edges: pairs.map(([source, target]) => ({ source, target, kind: 'calls' })) };
}

describe('sliceGraph（纯函数，v2 §6.1 定稿规则）', () => {
  it('fan-in ≥ 3 → shared；争用按最短跳/顺序归属', () => {
    // t1/t2/t3→a（a 被 3 入口可达 → shared）；t1→b；t1→c、t2→c（c 争用 → e1）
    const g = graphOf(
      [
        ['t1', 'a'],
        ['t2', 'a'],
        ['t3', 'a'],
        ['t1', 'b'],
        ['t1', 'c'],
        ['t2', 'c'],
      ],
      ['t1', 't2', 't3', 'a', 'b', 'c'],
    );
    const out = sliceGraph(g, [entry('e1', 't1'), entry('e2', 't2'), entry('e3', 't3')], { giantRatio: 1.1 });
    assert.deepEqual(out.shared.map((s) => s.id), ['a']);
    assert.equal(out.slices.length, 3);
    const e1 = out.slices.find((s) => s.entries[0]?.id === 'e1');
    assert.ok(e1?.members.has('b'));
    assert.ok(e1?.members.has('c'), '争用节点 c 平手按 entry 顺序归 e1');
    assert.ok(!e1?.members.has('a'), 'shared 节点不属于任何切片');
  });

  it('巨型入口（>40%）降级 seed，不单独成片', () => {
    const g = graphOf(
      [
        ['t', 'x'],
        ['x', 'y'],
      ],
      ['t', 'x', 'y'],
    );
    const out = sliceGraph(g, [entry('e1', 't')]);
    assert.equal(out.slices.length, 0);
    assert.ok(out.notes.some((s) => s.includes('降级为 seed')));
    const seeds = computeGiantSeeds(g, [entry('e1', 't')]);
    assert.equal(seeds.length, 1);
    assert.equal(seeds[0]?.reachable, 3);
  });

  it('包含度 >0.7 合并入口（共享同一 handler）', () => {
    // e1/e2 都缝到 t：t 归双方，a 争用归 e1 → e1{t,a} e2{t} 包含度 1 → 合并
    const g = graphOf([['t', 'a']], ['t', 'a']);
    const out = sliceGraph(g, [entry('e1', 't'), entry('e2', 't')], { giantRatio: 1.1 });
    assert.equal(out.slices.length, 1);
    assert.equal(out.slices[0]?.entries.length, 2);
    assert.equal(out.slices[0]?.members.size, 2);
  });

  it('maxFeatureNodes 截断（保留最近跳数）', () => {
    const pairs: Array<[string, string]> = [];
    const symbols: string[] = ['t'];
    for (let i = 1; i <= 10; i++) {
      pairs.push([i === 1 ? 't' : `n${i - 1}`, `n${i}`]);
      symbols.push(`n${i}`);
    }
    const g = graphOf(pairs, symbols);
    const out = sliceGraph(g, [entry('e1', 't')], { maxFeatureNodes: 3, giantRatio: 1.1 });
    const s = out.slices[0];
    assert.equal(s?.members.size, 3);
    assert.equal(s?.truncated, true);
    assert.equal(s?.members.get('n2'), 2, '保留的是离入口最近的');
  });
});

describe('buildFeatures / describeFeature（端到端）', () => {
  it('GET/POST 切片因包含度合并；空入口丢弃并记 note', async () => {
    const dir = await withAdaptersMirror();
    const r = buildFeatures(dir, { giantRatio: 0.95 });

    assert.equal(r.entriesConsidered, 4);
    assert.equal(r.features.length, 1, `features=${JSON.stringify(r.features.map((f) => f.name))}`);
    const f = r.features[0] as (typeof r.features)[number];
    assert.equal(f.entrypoints.length, 2);
    assert.equal(f.nodes, 4); // getUsers, svc, repo, util
    assert.ok(f.files.includes('src/server.ts'));
    assert.ok(f.files.includes('src/b.ts'));
    assert.equal(f.coverage.state, 'partial');
    assert.ok(r.notes.some((s) => s.includes('可达集为空')));
  });

  it('describeFeature：成员明细 + 入口证据', async () => {
    const dir = await withAdaptersMirror();
    const r = buildFeatures(dir, { giantRatio: 0.95 });
    const name = (r.features[0] as (typeof r.features)[number]).name;
    const d = describeFeature(dir, name, { giantRatio: 0.95 });
    assert.ok(d);
    assert.equal(d.members.length, 4);
    assert.ok(d.members.some((m) => m.name === 'getUsers'));
    assert.equal(d.evidence.length, 2);
    assert.ok(d.evidence[0]?.includes('src/server.ts:1'));
  });

  it('无 L4 入口 → 空报告 + 诚实 note', async () => {
    const dir = createFixtureProject({});
    await buildMirror(dir, { status: fakeStatus(dir) });
    const r = buildFeatures(dir);
    assert.equal(r.features.length, 0);
    assert.ok(r.notes[0]?.includes('没有 L4 入口'));
  });

  it('feature 未找到时报候选', async () => {
    const dir = await withAdaptersMirror();
    assert.throws(() => describeFeature(dir, '不存在的功能'), /feature 未找到/);
  });
});

describe('impactAnalysis（影响面 + L4 放大）', () => {
  it('反向可达 + 路由入口放大', async () => {
    const dir = await withAdaptersMirror();
    const r = impactAnalysis(dir, 'svc');
    const ids = new Set(r.impacted.map((h) => h.id));
    assert.ok(ids.has('n:main'), '直接调用方 main');
    assert.ok(ids.has('n:getUsers'), '调用方 getUsers');
    assert.equal(r.impacted.find((h) => h.id === 'n:main')?.dist, 1);
    // L4 放大：GET/POST 路由缝到 getUsers → 受影响
    assert.equal(r.entryHits.length, 2);
    assert.ok(r.entryHits.every((e) => e.label.includes('/api/users')));
  });

  it('歧义/未知符号报错', async () => {
    const dir = await withAdaptersMirror();
    assert.throws(() => impactAnalysis(dir, 'no-such-sym'), /未找到/);
  });
});

describe('search / outline（薄封装）', () => {
  it('searchNodes：LIKE 检索返回 top-N', async () => {
    const dir = await withAdaptersMirror();
    const hits = searchNodes(dir, 'svc');
    assert.ok(hits.some((h) => h.id === 'n:svc'));
    assert.ok(searchNodes(dir, '不存在的xx').length === 0);
  });

  it('outlineNode：节点本体 + contains 层级（fixture 无 contains → 空层级）', async () => {
    const dir = await withAdaptersMirror();
    const o = outlineNode(dir, 'n:svc');
    assert.equal(o.node.name, 'svc');
    assert.equal(o.node.filePath, 'src/b.ts');
    assert.deepEqual(o.parents, []);
    assert.deepEqual(o.children, []);
    assert.throws(() => outlineNode(dir, 'nope'), /未找到/);
  });
});

describe('impact 注入 L4 后的图完整性', () => {
  it('loadGraph 不受 L4 注入污染（每次调用独立）', async () => {
    const dir = await withAdaptersMirror();
    impactAnalysis(dir, 'svc');
    const db = openOwnDb(dir);
    try {
      const g = loadGraph(db);
      assert.ok(![...g.nodes.keys()].some((id) => id.startsWith('l4:')), '镜像库中不应有 L4 节点');
    } finally {
      db.close();
    }
  });
});
