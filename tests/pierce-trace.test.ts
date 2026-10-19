import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildMirror } from '../src/db/mirror.js';
import { pierceBoundary } from '../src/core/pierce.js';
import { tracePath } from '../src/core/trace.js';
import { createFixtureProject, fakeStatus } from './helpers/fixture.js';

async function withMirror(): Promise<string> {
  const dir = createFixtureProject({ extras: true });
  await buildMirror(dir, { status: fakeStatus(dir) });
  return dir;
}

describe('pierceBoundary（rea 穿透）', () => {
  it('rea 未安装 → 诚实 blocked + 安装指引（绝不静默安装）', async () => {
    const dir = await withMirror();
    const r = await pierceBoundary(dir, 'native/addon.node');
    assert.equal(r.status, 'blocked');
    assert.ok(r.guidance?.some((g) => g.includes('npm i -g rea-agents')));
    assert.equal(r.result, undefined);
  });

  it('注入 fake runner：解析 JSON 并缓存，第二次命中缓存（runner 只调一次）', async () => {
    const dir = await withMirror();
    let calls = 0;
    const runner = async () => {
      calls++;
      return { ok: true, stdout: '{"exports":["addon.add","addon.mul"],"symbols":2}', stderr: '' };
    };
    const r1 = await pierceBoundary(dir, 'boundary:native:native/addon.node', { runner });
    assert.equal(r1.status, 'pierce-ok');
    const result = r1.result as { exports: string[] };
    assert.deepEqual(result.exports, ['addon.add', 'addon.mul']);
    assert.equal(calls, 1);

    const r2 = await pierceBoundary(dir, 'native/addon.node', { runner });
    assert.equal(r2.status, 'cached');
    assert.equal(r2.boundary.path, 'native/addon.node');
    assert.equal(calls, 1, '缓存命中不再调 runner');
  });

  it('runner 失败 → pierce-failed 带错误', async () => {
    const dir = await withMirror();
    // 用不同边界避免缓存污染
    const runner = async () => ({ ok: false, stdout: '', stderr: 'boom' });
    const r = await pierceBoundary(dir, 'pkg.wasm', { runner });
    assert.equal(r.status, 'pierce-failed');
    assert.equal(r.error, 'boom');
  });

  it('未知边界 → 报错并列出可用边界', async () => {
    const dir = await withMirror();
    await assert.rejects(() => pierceBoundary(dir, 'nope.bin'), /边界未找到.*native\/addon\.node/s);
  });
});

describe('tracePath（跨缝调用链）', () => {
  it('有向最短路径：main → repo 经 svc（2 跳）', async () => {
    const dir = await withMirror();
    const r = tracePath(dir, 'main', 'repo');
    assert.equal(r.found, true);
    assert.equal(r.hops, 2);
    assert.deepEqual(r.path.map((p) => p.name), ['main', 'svc', 'repo']);
    assert.deepEqual(r.edgeKinds, ['calls', 'calls']);
    assert.equal(r.undirected, false);
    assert.equal(r.path[0]?.file, 'src/a.ts');
  });

  it('有向不可达时无向回退并注明', async () => {
    const dir = await withMirror();
    const r = tracePath(dir, 'repo', 'main'); // repo 无出边 → 有向不可达
    assert.equal(r.found, true);
    assert.equal(r.undirected, true);
    assert.ok(r.note?.includes('无向回退'));
  });

  it('有向不可达且禁用无向回退 → found=false', async () => {
    const dir = await withMirror();
    const r = tracePath(dir, 'repo', 'main', { undirected: false }); // repo 无出边
    assert.equal(r.found, false);
    assert.deepEqual(r.path, []);
  });

  it('歧义名报候选；未知名报错', async () => {
    const dir = await withMirror();
    assert.throws(() => tracePath(dir, 'no-such-symbol', 'main'), /未找到/);
  });
});
