import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildMirror } from '../src/db/mirror.js';
import { openOwnDb } from '../src/db/own.js';
import { loadGraph, type LoadedGraph, type GraphNode } from '../src/core/graph-load.js';
import { foldGraph } from '../src/core/map-fold.js';
import { renderDot, renderJson, renderMermaid } from '../src/core/map-render.js';
import { buildMap } from '../src/core/map.js';
import { createFixtureProject, fakeStatus } from './helpers/fixture.js';

async function withMirror(extras = false): Promise<string> {
  const dir = createFixtureProject({ extras });
  await buildMirror(dir, { status: fakeStatus(dir) });
  return dir;
}

function loadFixtureGraph(dir: string): LoadedGraph {
  const db = openOwnDb(dir);
  try {
    return loadGraph(db);
  } finally {
    db.close();
  }
}

function synthGraph(): LoadedGraph {
  // 5 个文件分散在 5 个顶层目录，链式调用：d1/a → d2/b → d3/c → d4/d → d5/e
  const files = ['d1/a.ts', 'd2/b.ts', 'd3/c.ts', 'd4/d.ts', 'd5/e.ts'];
  const nodes = new Map<string, GraphNode>();
  files.forEach((fp, i) => {
    nodes.set(`n${i}`, {
      id: `n${i}`, kind: 'function', name: `fn${i}`, qualifiedName: `fn${i}`,
      filePath: fp, language: 'typescript', startLine: 1, endLine: 5,
    });
  });
  const edges = [];
  for (let i = 0; i < 4; i++) edges.push({ source: `n${i}`, target: `n${i + 1}`, kind: 'calls' });
  return { nodes, edges };
}

describe('foldGraph（自适应聚合折叠）', () => {
  it('module 级：按文件聚合，重复边计权重，自环丢弃', async () => {
    const dir = await withMirror(true);
    const g = loadFixtureGraph(dir);
    const m = foldGraph(g, { level: 'module', maxNodes: 60 });

    assert.equal(m.nodes.length, 3); // node_modules 已排除
    const keys = m.nodes.map((n) => n.key).sort();
    assert.deepEqual(keys, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
    assert.equal(m.edges.length, 2);
    const ab = m.edges.find((e) => e.source === 'src/a.ts' && e.target === 'src/b.ts');
    assert.equal(ab?.weight, 2, 'main→svc 两条边聚合 weight=2');
    assert.equal(m.edges.find((e) => e.source === 'src/b.ts' && e.target === 'src/b.ts'), undefined);
    assert.ok(m.nodes.every((n) => n.parent === 'src'));
  });

  it('system 级：目录自适应折叠', async () => {
    const dir = await withMirror(true);
    const g = loadFixtureGraph(dir);
    const m = foldGraph(g, { level: 'system', maxNodes: 60 });

    assert.equal(m.nodes.length, 1);
    assert.equal(m.nodes[0]?.key, 'src');
    assert.equal(m.edges.length, 0);
  });

  it('symbol 级：符号为节点，去重后 3 条边', async () => {
    const dir = await withMirror(true);
    const g = loadFixtureGraph(dir);
    const m = foldGraph(g, { level: 'symbol', maxNodes: 60 });

    assert.equal(m.nodes.length, 4);
    const ms = m.edges.find((e) => e.source === 'n:main' && e.target === 'n:svc');
    assert.equal(ms?.weight, 2);
    assert.equal(m.edges.length, 3);
  });

  it('module 级超 maxNodes → 降级按目录折叠并记 note', async () => {
    const dir = await withMirror(true);
    const g = loadFixtureGraph(dir);
    const m = foldGraph(g, { level: 'module', maxNodes: 2 });

    assert.equal(m.nodes.length, 1);
    assert.ok(m.notes.some((s) => s.includes('目录折叠')));
  });

  it('system 级目录仍超限 → (other) 折叠 + truncated', () => {
    const m = foldGraph(synthGraph(), { level: 'system', maxNodes: 2 });
    assert.ok(m.truncated);
    assert.equal(m.nodes.length, 2);
    assert.ok(m.nodes.some((n) => n.key === '(other)'));
  });

  it('focus + depth：无向 BFS，保留边方向', async () => {
    const dir = await withMirror(true);
    const g = loadFixtureGraph(dir);
    // repo 的 1 跳邻居：svc（出边来源）→ 节点 repo+svc，边仅 svc→repo
    const m = foldGraph(g, { level: 'symbol', maxNodes: 60, focus: 'n:repo', depth: 1 });
    assert.equal(m.nodes.length, 2);
    assert.equal(m.edges.length, 1);
    assert.equal(m.edges[0]?.source, 'n:svc');

    // svc 1 跳：main（入）、repo、util 全到 → 4 节点 3 边
    const m2 = foldGraph(g, { level: 'symbol', maxNodes: 60, focus: 'n:svc', depth: 1 });
    assert.equal(m2.nodes.length, 4);
    assert.equal(m2.edges.length, 3);
  });

  it('focus 未找到 / 歧义时给出候选报错', async () => {
    const dir = await withMirror(true);
    const g = loadFixtureGraph(dir);
    assert.throws(() => foldGraph(g, { level: 'symbol', maxNodes: 60, focus: 'nope' }), /focus 未找到/);
  });
});

describe('渲染器', () => {
  it('mermaid：graph LR + 转义 + subgraph', async () => {
    const dir = await withMirror(true);
    const g = loadFixtureGraph(dir);
    const m = foldGraph(g, { level: 'module', maxNodes: 60 });
    const out = renderMermaid(m);
    assert.ok(out.startsWith('graph LR'));
    assert.ok(out.includes('subgraph S_src["src"]'));
    assert.ok(out.includes('-->|'));
  });

  it('dot：digraph + cluster', async () => {
    const dir = await withMirror(true);
    const g = loadFixtureGraph(dir);
    const m = foldGraph(g, { level: 'module', maxNodes: 60 });
    const out = renderDot(m);
    assert.ok(out.startsWith('digraph codemap {'));
    assert.ok(out.includes('subgraph cluster_0'));
    assert.ok(out.endsWith('}'));
  });

  it('json：codemap-graph/v1 契约', async () => {
    const dir = await withMirror(true);
    const g = loadFixtureGraph(dir);
    const m = foldGraph(g, { level: 'module', maxNodes: 60 });
    const parsed = JSON.parse(renderJson(m)) as { schema: string; nodes: unknown[]; edges: unknown[] };
    assert.equal(parsed.schema, 'codemap-graph/v1');
    assert.equal(parsed.nodes.length, 3);
    assert.equal(parsed.edges.length, 2);
  });
});

describe('buildMap（端到端）', () => {
  it('默认 system+mermaid；scope module 过滤', async () => {
    const dir = await withMirror(true);
    const r1 = buildMap(dir, {});
    assert.equal(r1.format, 'mermaid');
    assert.equal(r1.stats.level, 'system');
    assert.ok(r1.delivery.inline);

    const r2 = buildMap(dir, { scope: 'module:src/b.ts', level: 'symbol' });
    // b.ts 内部：svc、util；svc→util 边
    assert.deepEqual(r2.stats, { level: 'symbol', nodes: 2, edges: 1, truncated: false, notes: [] });

    assert.throws(() => buildMap(dir, { scope: 'feature:x' }), /scope 仅支持/);
  });
});
