import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { HANDLE_TTL_MS } from '../config.js';

/** 投影落库（v2 §7 响应预算：摘要 + handle，codemap_get 分页取全量） */
export function putProjection(
  db: DatabaseSync,
  payload: string,
  opts: { handle?: string; ttlMs?: number; now?: number } = {},
): string {
  const handle = opts.handle ?? randomUUID();
  const now = opts.now ?? Date.now();
  db.prepare(
    'INSERT INTO projections(handle, payload, created_at, expires_at) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(handle) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at, expires_at = excluded.expires_at',
  ).run(handle, payload, now, now + (opts.ttlMs ?? HANDLE_TTL_MS));
  return handle;
}

export interface ProjectionHit {
  payload: string;
  createdAt: number;
  expiresAt: number;
}

export function getProjection(
  db: DatabaseSync,
  handle: string,
  now = Date.now(),
): ProjectionHit | 'missing' | 'expired' {
  const row = db
    .prepare('SELECT payload, created_at AS createdAt, expires_at AS expiresAt FROM projections WHERE handle = ?')
    .get(handle) as { payload: string; createdAt: number; expiresAt: number } | undefined;
  if (!row) return 'missing';
  if (row.expiresAt < now) return 'expired';
  return { payload: row.payload, createdAt: row.createdAt, expiresAt: row.expiresAt };
}

export function pruneProjections(db: DatabaseSync, now = Date.now()): number {
  const r = db.prepare('DELETE FROM projections WHERE expires_at < ?').run(now);
  return Number(r.changes ?? 0);
}

export const PROJECTION_PAGE_CHARS = 20_000;

export function pagePayload(
  payload: string,
  offset = 0,
): { chunk: string; offset: number; nextOffset: number | null; total: number } {
  const total = payload.length;
  const start = Math.min(Math.max(0, offset), total);
  const chunk = payload.slice(start, start + PROJECTION_PAGE_CHARS);
  const next = start + chunk.length;
  return { chunk, offset: start, nextOffset: next < total ? next : null, total };
}

export interface PayloadDelivery {
  /** true = payload 为全文；false = payload 为预览片段，全文按 handle 取 */
  inline: boolean;
  payload: string;
  handle?: string;
  total: number;
  summary?: string;
}

/** 投影投递（v2 §7 响应预算）：短则内联全文，长则落库 + handle + 预览 */
export function deliverPayload(db: DatabaseSync, payload: string, summary?: string): PayloadDelivery {
  const total = payload.length;
  if (total <= PROJECTION_PAGE_CHARS) {
    return { inline: true, payload, total, summary };
  }
  const handle = putProjection(db, payload);
  return { inline: false, payload: payload.slice(0, 2_000), handle, total, summary };
}
