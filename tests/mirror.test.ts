import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildMirror, MirrorError } from '../src/db/mirror.js';
import { openOwnDb, readMeta } from '../src/db/own.js';
import { computeProjectCoverage } from '../src/core/coverage.js';
import { createFixtureProject, fakeStatus } from './helpers/fixture.js';

describe('buildMirror（镜像 ETL）', () => {
  it('全量镜像上游 L0–L2 并写入 meta', async () => {
    const dir = createFixtureProject();
    const res = await buildMirror(dir, { status: fakeStatus(dir) });

    assert.deepEqual(res.counts, { nodes: 4, edges: 4, unresolvedRefs: 2, files: 3 });
    assert.equal(res.extractionVersion, 24);
    assert.equal(res.copiedAside, false);
    assert.ok(res.durationMs >= 0);

    assert.ok(fs.existsSync(path.join(dir, '.codemap', 'codemap.db')));
    const db = openOwnDb(dir);
    try {
      const n = Number((db.prepare('SELECT COUNT(*) AS n FROM nodes').get() as { n: number }).n);
      assert.equal(n, 4);
      const up = db
        .prepare("SELECT reference_name FROM unresolved_refs WHERE file_path = 'src/a.ts'")
        .get() as { reference_name: string } | undefined;
      assert.equal(up?.reference_name, 'db.query');
      assert.equal(readMeta(db, 'extraction_version'), '24');
      assert.ok(readMeta(db, 'mirrored_at'));
      // coverage 与 fixture 数据自洽：resolved 4 / unresolved 2 → 0.667 → partial
      const cov = computeProjectCoverage(db);
      assert.equal(cov.state, 'partial');
      assert.ok(Math.abs((cov.ratio ?? 0) - 4 / 6) < 1e-9);
    } finally {
      db.close();
    }
  });

  it('extraction 不在白名单时拒绝，且上游与 .codemap 均未被写入', async () => {
    const dir = createFixtureProject({ extraction: 25 });
    const upstreamFile = path.join(dir, '.codegraph', 'codegraph.db');
    const before = fs.statSync(upstreamFile).mtimeMs;

    await assert.rejects(
      () => buildMirror(dir, { status: fakeStatus(dir, { extraction: 25 }) }),
      (err: unknown) => err instanceof MirrorError && err.code === 'extraction-mismatch',
    );

    assert.equal(fs.statSync(upstreamFile).mtimeMs, before);
    assert.equal(fs.existsSync(path.join(dir, '.codemap')), false);
  });

  it('未初始化工程拒绝（not-initialized），不代跑索引', async () => {
    const dir = createFixtureProject();
    await assert.rejects(
      () => buildMirror(dir, { status: fakeStatus(dir, { initialized: false }) }),
      (err: unknown) => err instanceof MirrorError && err.code === 'not-initialized',
    );
  });

  it('重复镜像 = 全量重建，行数不叠加', async () => {
    const dir = createFixtureProject();
    await buildMirror(dir, { status: fakeStatus(dir) });
    const res2 = await buildMirror(dir, { status: fakeStatus(dir) });
    assert.deepEqual(res2.counts, { nodes: 4, edges: 4, unresolvedRefs: 2, files: 3 });

    const db = openOwnDb(dir);
    try {
      const n = Number((db.prepare('SELECT COUNT(*) AS n FROM edges').get() as { n: number }).n);
      assert.equal(n, 4, '重建后不应残留旧行');
    } finally {
      db.close();
    }
  });

  it('上游库内 extraction 与 status 不一致时拒绝（belt & braces）', async () => {
    // fixture 元数据写 24，status 谎报 25 → 白名单在 status 通道先拦
    const dir = createFixtureProject({ extraction: 24 });
    await assert.rejects(
      () => buildMirror(dir, { status: fakeStatus(dir, { extraction: 25 }) }),
      (err: unknown) => err instanceof MirrorError && err.code === 'extraction-mismatch',
    );
  });
});
