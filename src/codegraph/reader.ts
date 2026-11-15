import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

/**
 * codegraph 的原始数据（我们只读，绝不写）。
 * schema 已按 codegraph 1.2.0 的 db/schema.sql 核对（v24）。
 */
export interface RawNode {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  isExported: boolean;
}

export interface RawEdge {
  source: string;
  target: string;
  kind: string;
  line: number | null;
  metadata: string | null;
}

export interface RawUnresolved {
  fromNodeId: string;
  referenceName: string;
  referenceKind: string;
  filePath: string;
  line: number;
}

export interface UpstreamGraph {
  nodes: Map<string, RawNode>;
  edges: RawEdge[];
  unresolved: RawUnresolved[];
  meta: Record<string, string>;
  copiedAside: boolean;
  fileCount: number;
  dispose(): void;
}

const BATCH = 5_000;

/**
 * 只读打开 codegraph 库。
 *
 * 不能经上游自己的 open() —— 它打开即跑 migration（写库）。这里直接 node:sqlite 只读，
 * 极端态（daemon 已死且 -shm 缺失）用 copy-aside：把 db+wal+shm 拷到临时目录读副本。
 */
export function openUpstream(dbFile: string): DatabaseSync {
  if (!fs.existsSync(dbFile)) throw new Error(`codegraph 库不存在: ${dbFile}`);
  try {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    db.prepare('SELECT count(*) AS n FROM sqlite_master').get();
    return db;
  } catch {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-aside-'));
    const base = path.basename(dbFile);
    for (const suffix of ['', '-wal', '-shm']) {
      const src = dbFile + suffix;
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmpDir, base + suffix));
    }
    const db = new DatabaseSync(path.join(tmpDir, base));
    db.prepare('SELECT count(*) AS n FROM sqlite_master').get();
    return db;
  }
}

/** 全量加载到内存（10 万节点 / 40 万边量级在 JS 内是亚秒级，够用） */
export function loadUpstream(dbFile: string): UpstreamGraph {
  const db = openUpstream(dbFile);
  const nodes = new Map<string, RawNode>();
  const edges: RawEdge[] = [];
  const unresolved: RawUnresolved[] = [];
  const meta: Record<string, string> = {};
  let fileCount = 0;

  const chunk = (sql: string, cb: (row: Record<string, unknown>) => void) => {
    const stmt = db.prepare(`${sql} WHERE rowid > ? ORDER BY rowid LIMIT ?`);
    let last = 0;
    for (;;) {
      const rows = stmt.all(last, BATCH) as Array<Record<string, unknown>>;
      if (rows.length === 0) break;
      for (const row of rows) {
        cb(row);
        last = Number(row.rowid);
      }
    }
  };

  chunk(
    'SELECT rowid, id, kind, name, qualified_name, file_path, language, start_line, end_line, is_exported FROM nodes',
    (r) => {
      const id = String(r.id);
      nodes.set(id, {
        id,
        kind: String(r.kind),
        name: String(r.name),
        qualifiedName: r.qualified_name == null ? '' : String(r.qualified_name),
        filePath: r.file_path == null ? '' : String(r.file_path),
        language: r.language == null ? '' : String(r.language),
        startLine: Number(r.start_line ?? 0),
        endLine: Number(r.end_line ?? 0),
        isExported: Number(r.is_exported ?? 0) === 1,
      });
    },
  );

  chunk('SELECT rowid, source, target, kind, line, metadata FROM edges', (r) => {
    edges.push({
      source: String(r.source),
      target: String(r.target),
      kind: String(r.kind),
      line: r.line == null ? null : Number(r.line),
      metadata: r.metadata == null ? null : String(r.metadata),
    });
  });

  try {
    chunk(
      'SELECT rowid, from_node_id, reference_name, reference_kind, file_path, line FROM unresolved_refs',
      (r) => {
        unresolved.push({
          fromNodeId: String(r.from_node_id ?? ''),
          referenceName: String(r.reference_name ?? ''),
          referenceKind: String(r.reference_kind ?? ''),
          filePath: String(r.file_path ?? ''),
          line: Number(r.line ?? 0),
        });
      },
    );
  } catch {
    // 老版本可能没有这张表：覆盖率退化为 null，不崩
  }

  try {
    const rows = db.prepare('SELECT key, value FROM project_metadata').all() as Array<{
      key: string;
      value: string;
    }>;
    for (const r of rows) meta[r.key] = r.value;
  } catch {
    /* 忽略 */
  }

  try {
    const row = db.prepare('SELECT count(*) AS n FROM files').get() as { n: number };
    fileCount = Number(row.n);
  } catch {
    fileCount = 0;
  }

  db.close();
  return {
    nodes,
    edges,
    unresolved,
    meta,
    copiedAside: false,
    fileCount,
    dispose: () => {
      /* 已关闭 */
    },
  };
}

/**
 * 测试文件过滤规则（用户明确要求：测试文件不参与）。
 * 只过滤「明确的测试」，不误伤 production 里名字带 test 的模块。
 */
const TEST_DIR_SEGMENTS = new Set([
  '__tests__',
  '__test__',
  '__mocks__',
  '__fixtures__',
  '__snapshots__',
  'test',
  'tests',
  'spec',
  'e2e',
  'testing',
  'cypress',
]);

const TEST_FILE_PATTERNS: RegExp[] = [
  /\.(test|spec|e2e|cy|bench|stories)\.[cm]?[jt]sx?$/i,
  /\.(test|spec)\.(py|go|rs|java|kt|cs|php|rb)$/i,
  /_test\.(go|py|rs)$/i,
  /Test\.(java|kt|cs)$/i,
  /Tests\.(java|kt|cs)$/i,
  /^test_.*\.py$/i,
];

export function isTestFile(relPath: string): boolean {
  const p = relPath.replace(/\\/g, '/');
  const lower = p.toLowerCase();
  const segments = lower.split('/');
  // 任意一段是测试目录（排除根目录本身）
  for (let i = 0; i < segments.length - 1; i++) {
    if (TEST_DIR_SEGMENTS.has(segments[i] as string)) return true;
  }
  const base = segments[segments.length - 1] ?? '';
  if (TEST_FILE_PATTERNS.some((re) => re.test(base))) return true;
  if (base === 'conftest.py' || base === 'setup_tests.py') return true;
  // jest/vitest 配置本身也算测试设施
  if (/^(jest|vitest|karma|playwright|cypress)\.config\.[cm]?[jt]s$/.test(base)) return true;
  return false;
}

/** 第三方/构建产物目录：结构性排除（这些不是本系统骨架的一部分） */
const EXCLUDED_DIRS = new Set([
  'node_modules',
  'bower_components',
  'vendor',
  '.git',
  '.svn',
  '.hg',
  '.codegraph',
  '.codemap',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  '.cache',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  'target',
  'bin',
  'obj',
  'Pods',
  'DerivedData',
]);

export function isExcludedPath(relPath: string): boolean {
  const segs = relPath.replace(/\\/g, '/').split('/');
  for (const s of segs) {
    if (EXCLUDED_DIRS.has(s)) return true;
    if (s.toLowerCase() === 'node_modules') return true;
  }
  return false;
}

export function sha1(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex');
}
