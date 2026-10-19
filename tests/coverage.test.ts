import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { coverageState, computeFilesCoverage } from '../src/core/coverage.js';
import { openOwnDb } from '../src/db/own.js';
import { createFixtureProject } from './helpers/fixture.js';
import { buildMirror } from '../src/db/mirror.js';
import { fakeStatus } from './helpers/fixture.js';

describe('coverageState（四态公式，v2 §6.1）', () => {
  it('unavailable：无数据', () => {
    assert.equal(coverageState(0, 0, false), 'unavailable');
    assert.equal(coverageState(0, 0, true), 'unavailable');
  });
  it('unknown：< 15%，图稀薄到无法据此推理', () => {
    assert.equal(coverageState(5, 95, true), 'unknown');
    assert.equal(coverageState(14, 86, true), 'unknown');
  });
  it('partial：15% ~ 95%', () => {
    assert.equal(coverageState(15, 85, true), 'partial');
    assert.equal(coverageState(50, 50, true), 'partial');
    // 实测工程量级：424k resolved / 595k unresolved → 41.6% → partial
    assert.equal(coverageState(423_920, 595_593, true), 'partial');
  });
  it('complete：≥ 95%', () => {
    assert.equal(coverageState(95, 5, true), 'complete');
    assert.equal(coverageState(100, 0, true), 'complete');
  });
});

describe('computeFilesCoverage（范围内 coverage）', () => {
  it('按文件集聚合 resolved/unresolved', async () => {
    const dir = createFixtureProject();
    await buildMirror(dir, { status: fakeStatus(dir) });
    const db = openOwnDb(dir);
    try {
      // src/a.ts：main 有 2 条出边（含重复边），1 条 unresolved → 2/3 → partial
      const a = computeFilesCoverage(db, ['src/a.ts']);
      assert.equal(a.resolved, 2);
      assert.equal(a.unresolved, 1);
      assert.equal(a.state, 'partial');
      // 全部三个文件：unresolved 2，edges 关联到这三个文件 4 条
      const all = computeFilesCoverage(db, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
      assert.equal(all.unresolved, 2);
      assert.equal(all.resolved, 4);
      assert.equal(all.state, 'partial');
      // 空范围 → unavailable
      assert.equal(computeFilesCoverage(db, []).state, 'unavailable');
    } finally {
      db.close();
    }
  });
});
