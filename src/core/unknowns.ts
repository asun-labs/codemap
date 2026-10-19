import type { DatabaseSync } from 'node:sqlite';
import { openOwnDb } from '../db/own.js';
import { computeFilesCoverage, type Coverage } from './coverage.js';

export interface UnknownsReport {
  projectPath: string;
  scope: string;
  total: number;
  coverage: Coverage;
  byKind: Array<{ kind: string; count: number }>;
  byDir: Array<{ dir: string; count: number; files: number }>;
  byFile: Array<{ file: string; count: number; topNames: string[] }>;
  mostWanted: Array<{ name: string; kind: string; count: number; sampleFiles: string[] }>;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * P2 unknowns（v2 §6.2）：聚合上游自己承认没解析的东西。
 * 这是「诚实覆盖度」的核心视图——不暴露它，使用者就会默认图是完整的。
 */
export function computeUnknowns(projectPath: string, scopePath?: string): UnknownsReport {
  const db: DatabaseSync = openOwnDb(projectPath);
  try {
    const scope = scopePath ? toPosix(scopePath).replace(/\/+$/, '') : null;
    const fileWhere = scope ? "WHERE file_path = ? OR file_path LIKE ? || '/%'" : '';
    const fileArgs = scope ? [scope, scope] : [];

    const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM unresolved_refs ${fileWhere}`).get(...fileArgs) as { n: number }).n);

    const byKind = (
      db
        .prepare(`SELECT reference_kind AS kind, COUNT(*) AS n FROM unresolved_refs ${fileWhere} GROUP BY reference_kind ORDER BY n DESC`)
        .all(...fileArgs) as Array<{ kind: string; n: number }>
    ).map((r) => ({ kind: r.kind, count: Number(r.n) }));

    const byDir = (
      db
        .prepare(
          `SELECT CASE WHEN instr(file_path, '/') = 0 THEN '(root)' ELSE substr(file_path, 1, instr(file_path, '/') - 1) END AS dir,
                  COUNT(*) AS n, COUNT(DISTINCT file_path) AS files
           FROM unresolved_refs ${fileWhere} GROUP BY dir ORDER BY n DESC LIMIT 10`,
        )
        .all(...fileArgs) as Array<{ dir: string; n: number; files: number }>
    ).map((r) => ({ dir: r.dir, count: Number(r.n), files: Number(r.files) }));

    const byFileRows = db
      .prepare(
        `SELECT file_path AS file, COUNT(*) AS n FROM unresolved_refs ${fileWhere}
         ${fileWhere ? 'AND' : 'WHERE'} file_path != '' GROUP BY file_path ORDER BY n DESC LIMIT 20`,
      )
      .all(...fileArgs) as Array<{ file: string; n: number }>;

    const byFile = byFileRows.map((r) => {
      const names = db
        .prepare('SELECT reference_name AS name FROM unresolved_refs WHERE file_path = ? ORDER BY id LIMIT 5')
        .all(r.file) as Array<{ name: string }>;
      return { file: toPosix(r.file), count: Number(r.n), topNames: names.map((x) => x.name) };
    });

    const mostWanted = (
      db
        .prepare(
          `SELECT reference_name AS name, reference_kind AS kind, COUNT(*) AS n
           FROM unresolved_refs ${fileWhere} GROUP BY reference_name, reference_kind ORDER BY n DESC LIMIT 15`,
        )
        .all(...fileArgs) as Array<{ name: string; kind: string; n: number }>
    ).map((r) => {
      const samples = db
        .prepare('SELECT DISTINCT file_path AS f FROM unresolved_refs WHERE reference_name = ? LIMIT 3')
        .all(r.name) as Array<{ f: string }>;
      return { name: r.name, kind: r.kind, count: Number(r.n), sampleFiles: samples.map((s) => toPosix(s.f)) };
    });

    // 范围内 coverage：范围内文件集
    const scopeFiles = scope
      ? (db.prepare('SELECT DISTINCT file_path AS f FROM unresolved_refs WHERE file_path = ? OR file_path LIKE ? || ?').all(scope, scope, '/%') as Array<{ f: string }>).map((r) => r.f)
      : [];
    const coverage = scope
      ? computeFilesCoverage(db, scopeFiles)
      : computeFilesCoverage(
          db,
          (db.prepare('SELECT path AS f FROM files').all() as Array<{ f: string }>).map((r) => r.f),
        );

    return {
      projectPath,
      scope: scope ?? 'project',
      total,
      coverage,
      byKind,
      byDir,
      byFile,
      mostWanted,
    };
  } finally {
    try {
      db.close();
    } catch {
      /* 已关闭则忽略 */
    }
  }
}
