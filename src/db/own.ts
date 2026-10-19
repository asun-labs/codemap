import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import { codemapDir, ownDbPath } from '../util/paths.js';

/**
 * 自家库 schema（v2 §3.3）：
 * 镜像表（nodes/edges/unresolved_refs/files，保留上游 id）+ 派生表（meta/projections）。
 */
const OWN_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT,
  file_path TEXT,
  language TEXT,
  start_line INTEGER,
  end_line INTEGER
);
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file_path);
CREATE TABLE IF NOT EXISTS edges (
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  kind TEXT NOT NULL,
  line INTEGER,
  col INTEGER,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);
CREATE INDEX IF NOT EXISTS idx_edges_source_kind ON edges(source, kind);
CREATE INDEX IF NOT EXISTS idx_edges_target_kind ON edges(target, kind);
CREATE TABLE IF NOT EXISTS unresolved_refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_node_id TEXT,
  reference_name TEXT NOT NULL,
  reference_kind TEXT NOT NULL,
  line INTEGER,
  col INTEGER,
  candidates TEXT,
  file_path TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'unknown'
);
CREATE INDEX IF NOT EXISTS idx_unresolved_file ON unresolved_refs(file_path);
CREATE INDEX IF NOT EXISTS idx_unresolved_kind ON unresolved_refs(reference_kind);
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  content_hash TEXT,
  language TEXT,
  size INTEGER
);
CREATE TABLE IF NOT EXISTS projections (
  handle TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
`;

/** 打开自家库；create=false 时镜像必须已存在 */
export function openOwnDb(projectPath: string, opts: { create?: boolean } = {}): DatabaseSync {
  const file = ownDbPath(projectPath);
  if (opts.create) {
    fs.mkdirSync(codemapDir(projectPath), { recursive: true });
  } else if (!fs.existsSync(file)) {
    throw new Error(`CodeMap 镜像不存在: ${file} —— 先运行 codemap mirror ${projectPath}`);
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(OWN_SCHEMA);
  return db;
}

export function readMeta(db: DatabaseSync, key: string): string | null {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export function writeMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    'INSERT INTO meta(key, value, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  ).run(key, value, Date.now());
}
