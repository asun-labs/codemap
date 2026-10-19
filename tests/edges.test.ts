import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildMirror } from '../src/db/mirror.js';
import { computeUnknowns } from '../src/core/unknowns.js';
import { scanEdges } from '../src/core/boundaries.js';
import { createFixtureProject, fakeStatus } from './helpers/fixture.js';

async function withMirror(): Promise<string> {
  const dir = createFixtureProject({ extras: true });
  await buildMirror(dir, { status: fakeStatus(dir) });
  return dir;
}

describe('computeUnknowns（盲区聚合）', () => {
  it('全工程聚合：byKind / byFile / mostWanted / coverage', async () => {
    const dir = await withMirror();
    const r = computeUnknowns(dir);

    assert.equal(r.total, 2);
    assert.deepEqual(r.byKind, [
      { kind: 'calls', count: 1 },
      { kind: 'references', count: 1 },
    ]);
    assert.equal(r.byFile.length, 2);
    const a = r.byFile.find((f) => f.file === 'src/a.ts');
    assert.deepEqual(a?.topNames, ['db.query']);
    const mw = r.mostWanted.find((x) => x.name === 'db.query');
    assert.deepEqual(mw?.sampleFiles, ['src/a.ts']);
    assert.equal(r.coverage.state, 'partial');
    // extras 后：resolved 5（含 node_modules 文件的边）/ unresolved 2 → 5/7
    assert.ok(Math.abs((r.coverage.ratio ?? 0) - 5 / 7) < 1e-9);
  });

  it('module 范围：只统计范围内', async () => {
    const dir = await withMirror();
    const r = computeUnknowns(dir, 'src/a.ts');
    assert.equal(r.total, 1);
    assert.equal(r.scope, 'src/a.ts');
    // extras 后 src/a.ts 内 main 有 3 条出边（2×svc + nm）→ 3 resolved / 1 unresolved → partial
    assert.equal(r.coverage.state, 'partial');
    assert.ok(Math.abs((r.coverage.ratio ?? 0) - 3 / 4) < 1e-9);
  });

  it('无镜像时报错并指引', async () => {
    const dir = createFixtureProject({ extras: true });
    assert.throws(() => computeUnknowns(dir), /镜像不存在/);
  });
});

describe('scanEdges（静态边界扫描）', () => {
  it('四类边界文件 + rea 穿透标注', async () => {
    const dir = await withMirror();
    const r = scanEdges(dir);

    const kinds = new Set(r.boundaries.map((b) => b.kind));
    assert.ok(kinds.has('native'));
    assert.ok(kinds.has('wasm'));
    assert.ok(kinds.has('asar'));

    const addon = r.boundaries.find((b) => b.path === 'native/addon.node');
    assert.ok(addon);
    assert.equal(addon.pierceable, true);
    assert.equal(addon.reaCommand, 'inspect-artifact');
    assert.deepEqual(addon.importers, ['src/a.ts'], '源码字面量引用算 importer 证据');

    const asar = r.boundaries.find((b) => b.path === 'resources/app.asar');
    assert.equal(asar?.reaCommand, 'analyze-javascript-application');
  });

  it('HTTP 出口与环境变量证据', async () => {
    const dir = await withMirror();
    const r = scanEdges(dir);

    const egress = r.httpEgress.find((e) => e.file === 'src/a.ts');
    assert.ok(egress);
    assert.deepEqual(egress.lines, [2], 'fetch( 在第 2 行');
    assert.ok(egress.samples[0]?.includes('fetch'));

    const names = r.envVars.map((v) => v.name);
    assert.ok(names.includes('API_KEY'));
    assert.ok(names.includes('VITE_FLAG'));
    const apiKey = r.envVars.find((v) => v.name === 'API_KEY');
    assert.deepEqual(apiKey?.files, ['src/a.ts']);
  });

  it('无 prisma/typeorm 时 DB 指示器为空；扫描计数合理', async () => {
    const dir = await withMirror();
    const r = scanEdges(dir);
    assert.equal(r.databases.length, 0);
    assert.ok(r.scanned.walkedFiles >= 6, `walked=${r.scanned.walkedFiles}`);
    assert.ok(r.scanned.sourceFiles >= 2);
    assert.equal(r.scanned.truncated, false);
  });
});
