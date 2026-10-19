import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openOwnDb } from '../src/db/own.js';
import { getProjection, pagePayload, PROJECTION_PAGE_CHARS, putProjection } from '../src/db/projections.js';
import { resolveProject } from '../src/util/paths.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-proj-'));
}

describe('projections（handle 落库与 TTL）', () => {
  it('put/get 往返', () => {
    const dir = tempProject();
    const db = openOwnDb(dir, { create: true });
    try {
      const payload = JSON.stringify({ hello: 'world' });
      const handle = putProjection(db, payload);
      assert.ok(handle.length > 0);
      const hit = getProjection(db, handle);
      assert.notEqual(hit, 'missing');
      assert.notEqual(hit, 'expired');
      if (typeof hit === 'object') assert.equal(hit.payload, payload);
    } finally {
      db.close();
    }
  });

  it('TTL 过期返回 expired', () => {
    const dir = tempProject();
    const db = openOwnDb(dir, { create: true });
    try {
      const handle = putProjection(db, 'x', { ttlMs: -1 });
      assert.equal(getProjection(db, handle), 'expired');
    } finally {
      db.close();
    }
  });

  it('未知 handle 返回 missing', () => {
    const dir = tempProject();
    const db = openOwnDb(dir, { create: true });
    try {
      assert.equal(getProjection(db, 'nope'), 'missing');
    } finally {
      db.close();
    }
  });

  it('pagePayload 分页与终止', () => {
    const payload = 'x'.repeat(PROJECTION_PAGE_CHARS + 5_000);
    const p1 = pagePayload(payload);
    assert.equal(p1.chunk.length, PROJECTION_PAGE_CHARS);
    assert.equal(p1.offset, 0);
    assert.equal(p1.nextOffset, PROJECTION_PAGE_CHARS);
    const p2 = pagePayload(payload, p1.nextOffset ?? 0);
    assert.equal(p2.chunk.length, 5_000);
    assert.equal(p2.nextOffset, null);
    assert.equal(p2.total, payload.length);
  });
});

describe('resolveProject', () => {
  it('缺省 = cwd；不存在路径报错', () => {
    assert.equal(resolveProject(undefined), process.cwd());
    assert.throws(() => resolveProject('Z:/definitely/not/exist/__codemap__'));
  });
});
