import type { DatabaseSync } from 'node:sqlite';

export type CoverageState = 'complete' | 'partial' | 'unknown' | 'unavailable';

/**
 * coverage 公式（v2 §6.1 定稿，P0 即用）：
 *   coverage = resolved / (resolved + unresolved)
 * 四态阈值：
 *   unavailable  无有效索引或依赖缺失
 *   unknown      coverage < 15%（图稀薄到无法据此推理）
 *   partial      15% ≤ coverage < 95%
 *   complete     coverage ≥ 95%
 */
export function coverageState(resolved: number, unresolved: number, hasData: boolean): CoverageState {
  if (!hasData || (resolved === 0 && unresolved === 0)) return 'unavailable';
  const total = resolved + unresolved;
  const ratio = resolved / total;
  if (ratio < 0.15) return 'unknown';
  if (ratio < 0.95) return 'partial';
  return 'complete';
}

export interface Coverage {
  resolved: number;
  unresolved: number;
  ratio: number | null;
  state: CoverageState;
}

export function computeProjectCoverage(db: DatabaseSync): Coverage {
  const resolved = Number((db.prepare('SELECT COUNT(*) AS n FROM edges').get() as { n: number }).n);
  const unresolved = Number((db.prepare('SELECT COUNT(*) AS n FROM unresolved_refs').get() as { n: number }).n);
  const hasData = resolved > 0 || unresolved > 0;
  const total = resolved + unresolved;
  return {
    resolved,
    unresolved,
    ratio: hasData ? resolved / total : null,
    state: coverageState(resolved, unresolved, hasData),
  };
}

/** 范围内（文件集）的 coverage——unknowns / describe_feature（P2/P5）复用 */
export function computeFilesCoverage(
  db: DatabaseSync,
  filePaths: string[],
): Coverage {
  if (filePaths.length === 0) return { resolved: 0, unresolved: 0, ratio: null, state: 'unavailable' };
  const placeholders = filePaths.map(() => '?').join(', ');
  const resolved = Number(
    (
      db
        .prepare(`SELECT COUNT(*) AS n FROM edges e JOIN nodes n ON e.source = n.id WHERE n.file_path IN (${placeholders})`)
        .get(...filePaths) as { n: number }
    ).n,
  );
  const unresolved = Number(
    (
      db
        .prepare(`SELECT COUNT(*) AS n FROM unresolved_refs WHERE file_path IN (${placeholders})`)
        .get(...filePaths) as { n: number }
    ).n,
  );
  const hasData = resolved > 0 || unresolved > 0;
  const total = resolved + unresolved;
  return {
    resolved,
    unresolved,
    ratio: hasData ? resolved / total : null,
    state: coverageState(resolved, unresolved, hasData),
  };
}
