import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildMirror } from '../src/db/mirror.js';
import { openOwnDb } from '../src/db/own.js';
import { loadGraph } from '../src/core/graph-load.js';
import { buildL4Index } from '../src/core/adapters.js';
import { buildMap } from '../src/core/map.js';
import { createFixtureProject, fakeStatus } from './helpers/fixture.js';

async function withAdaptersMirror(): Promise<string> {
  const dir = createFixtureProject({ adapters: true });
  await buildMirror(dir, { status: fakeStatus(dir) });
  return dir;
}

describe('buildL4Index（L4 适配器，行级正则 + file:line 缝合）', () => {
  it('express 路由：提取 + 缝合到 getUsers 符号', async () => {
    const dir = await withAdaptersMirror();
    const db = openOwnDb(dir);
    const g = loadGraph(db);
    db.close();
    const r = buildL4Index(dir, g);

    const routes = r.nodes.filter((n) => n.kind === 'route');
    assert.equal(routes.length, 3);
    assert.deepEqual(
      routes.map((n) => n.label),
      ['GET /api/users', 'POST /api/users', 'DELETE /api/users/:id'],
    );
    const get = routes[0] as { targetNodeId: string | null; confidence: string; filePath: string; line: number };
    assert.equal(get.targetNodeId, 'n:getUsers', '按 file:line 缝合');
    assert.equal(get.confidence, 'partial');
    assert.equal(get.filePath, 'src/server.ts');
    assert.equal(get.line, 1);
    // 前两条路由缝到 getUsers（1-2 行）；第三条（line 3）无符号可缝 → 无缝合边，confidence=inferred
    assert.equal(r.edges.length, 2);
    assert.ok(r.edges.every((e) => e.target === 'n:getUsers'));
    const del = routes[2] as { targetNodeId: string | null; confidence: string };
    assert.equal(del.targetNodeId, null);
    assert.equal(del.confidence, 'inferred');
  });

  it('electron：IPC channel + contextBridge', async () => {
    const dir = await withAdaptersMirror();
    const r = buildL4Index(dir);
    const ipc = r.nodes.find((n) => n.kind === 'ipc');
    assert.equal(ipc?.label, 'IPC settings:save');
    assert.equal(ipc?.filePath, 'src/ipc.ts');
    const bridge = r.nodes.find((n) => n.kind === 'bridge');
    assert.equal(bridge?.label, 'BRIDGE settings');
    assert.equal(bridge?.confidence, 'inferred');
  });

  it('prisma：model → table 节点', async () => {
    const dir = await withAdaptersMirror();
    const r = buildL4Index(dir);
    const tables = r.nodes.filter((n) => n.kind === 'table');
    assert.deepEqual(tables.map((t) => t.label).sort(), ['TABLE Post', 'TABLE User']);
    assert.ok(tables.every((t) => t.filePath === 'prisma/schema.prisma'));
  });

  it('无 package.json → 全部适配器未检出，0 节点', async () => {
    const dir = createFixtureProject({});
    const r = buildL4Index(dir);
    assert.equal(r.nodes.length, 0);
    assert.ok(r.adapters.every((a) => !a.detected));
  });

  it('map --include-l4：L4 节点并入符号级图', async () => {
    const dir = await withAdaptersMirror();
    const r = buildMap(dir, { level: 'symbol', maxNodes: 100, includeL4: true });
    assert.ok(r.delivery.inline);
    const payload = r.delivery.payload;
    assert.ok(payload.includes('l4:'), 'mermaid/dot 输出应含 L4 节点');
    assert.ok(r.stats.notes.some((s) => s.includes('L4 并入 7 节点')), `notes=${JSON.stringify(r.stats.notes)}`);
  });
});
