import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CodegraphStatus } from '../../src/core/codegraph-status.js';

/**
 * 按 codegraph 1.2.0 真实 schema（db/schema.sql 的相关子集）造一个上游库 fixture。
 * 字段名/类型与 lib/dist/db/schema.sql 一致，保证 ETL 的 SELECT 列名成立。
 */
const UPSTREAM_SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_versions (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  description TEXT
);
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  language TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  start_column INTEGER,
  end_column INTEGER,
  docstring TEXT,
  signature TEXT,
  visibility TEXT,
  is_exported INTEGER DEFAULT 0,
  is_async INTEGER DEFAULT 0,
  is_static INTEGER DEFAULT 0,
  is_abstract INTEGER DEFAULT 0,
  decorators TEXT,
  type_parameters TEXT,
  return_type TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  kind TEXT NOT NULL,
  metadata TEXT,
  line INTEGER,
  col INTEGER,
  provenance TEXT DEFAULT NULL
);
CREATE TABLE IF NOT EXISTS unresolved_refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_node_id TEXT NOT NULL,
  reference_name TEXT NOT NULL,
  reference_kind TEXT NOT NULL,
  line INTEGER NOT NULL,
  col INTEGER NOT NULL,
  candidates TEXT,
  file_path TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'unknown'
);
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  language TEXT NOT NULL,
  size INTEGER NOT NULL,
  modified_at INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL,
  node_count INTEGER DEFAULT 0,
  errors TEXT
);
CREATE TABLE IF NOT EXISTS project_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export interface FixtureOpts {
  extraction?: number;
  /** 追加 node_modules 内的节点与出边（验证 map 的 node_modules 排除） */
  extras?: boolean;
}

export function createFixtureProject(opts: FixtureOpts = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-fixture-'));
  const cgDir = path.join(dir, '.codegraph');
  fs.mkdirSync(cgDir, { recursive: true });
  const db = new DatabaseSync(path.join(cgDir, 'codegraph.db'));
  db.exec(UPSTREAM_SCHEMA);

  const now = Date.now();
  const files = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
  files.forEach((f, i) => {
    db.prepare('INSERT INTO files(path, content_hash, language, size, modified_at, indexed_at) VALUES (?,?,?,?,?,?)').run(
      f,
      `hash${i}`,
      'typescript',
      100 + i,
      now,
      now,
    );
  });

  const nodeRows: Array<[string, string, string, string, string, number, number]> = [
    ['n:main', 'function', 'main', 'main', 'src/a.ts', 1, 10],
    ['n:svc', 'function', 'svc', 'svc', 'src/b.ts', 1, 10],
    ['n:repo', 'function', 'repo', 'repo', 'src/c.ts', 1, 10],
    ['n:util', 'function', 'util', 'util', 'src/b.ts', 20, 25],
  ];
  for (const [id, kind, name, qual, file, l1, l2] of nodeRows) {
    db.prepare(
      'INSERT INTO nodes(id, kind, name, qualified_name, file_path, language, start_line, end_line, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(id, kind, name, qual, file, 'typescript', l1, l2, now);
  }

  const edgeRows: Array<[string, string, string]> = [
    ['n:main', 'n:svc', 'calls'],
    ['n:svc', 'n:repo', 'calls'],
    ['n:svc', 'n:util', 'calls'],
    ['n:main', 'n:svc', 'calls'], // 重复边，验证原样镜像
  ];
  for (const [s, t, k] of edgeRows) {
    db.prepare('INSERT INTO edges(source, target, kind, line, col) VALUES (?,?,?,?,?)').run(s, t, k, 1, 1);
  }

  db.prepare(
    'INSERT INTO unresolved_refs(from_node_id, reference_name, reference_kind, line, col, file_path, language) VALUES (?,?,?,?,?,?,?)',
  ).run('n:main', 'db.query', 'calls', 5, 3, 'src/a.ts', 'typescript');
  db.prepare(
    'INSERT INTO unresolved_refs(from_node_id, reference_name, reference_kind, line, col, file_path, language) VALUES (?,?,?,?,?,?,?)',
  ).run('n:svc', 'externalApi', 'references', 7, 3, 'src/b.ts', 'typescript');

  db.prepare("INSERT INTO project_metadata(key, value, updated_at) VALUES ('indexed_with_extraction_version', ?, ?)").run(
    String(opts.extraction ?? 24),
    now,
  );

  if (opts.extras) {
    db.prepare(
      'INSERT INTO files(path, content_hash, language, size, modified_at, indexed_at) VALUES (?,?,?,?,?,?)',
    ).run('node_modules/pkg/index.ts', 'hashnm', 'javascript', 10, now, now);
    db.prepare(
      'INSERT INTO nodes(id, kind, name, qualified_name, file_path, language, start_line, end_line, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run('n:nm', 'function', 'nmfn', 'nmfn', 'node_modules/pkg/index.ts', 'javascript', 1, 5, now);
    db.prepare('INSERT INTO edges(source, target, kind, line, col) VALUES (?,?,?,?,?)').run('n:main', 'n:nm', 'calls', 2, 1);
  }

  db.close();
  return dir;
}

/** 构造与 CodegraphStatus 形状一致的对象（避免测试里真的 spawn codegraph） */
export function fakeStatus(
  projectPath: string,
  opts: { extraction?: number; initialized?: boolean; lastIndexed?: string } = {},
): CodegraphStatus {
  const extraction = opts.extraction ?? 24;
  return {
    available: true,
    initialized: opts.initialized ?? true,
    version: '1.2.0-test',
    projectPath,
    indexPath: path.join(projectPath, '.codegraph'),
    lastIndexed: opts.lastIndexed ?? new Date().toISOString(),
    fileCount: 3,
    nodeCount: 4,
    edgeCount: 4,
    journalMode: 'wal',
    pendingChanges: { added: 0, modified: 0, removed: 0 },
    index: {
      builtWithVersion: 'v1.2.0',
      builtWithExtractionVersion: extraction,
      currentExtractionVersion: extraction,
      reindexRecommended: false,
    },
  };
}
